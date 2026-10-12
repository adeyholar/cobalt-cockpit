// Optional verification enforcement for unattended runs, on Claude Code's Stop
// hook (`classic.Stop`: `stop_hook_active` in, `decision: "block"` + `reason`
// out, which the plugin API spells `{ block: reason }`).
//
//   OBSERVE (default)  nothing here runs: no process, no model call, no block.
//   ENFORCE (opt-in)   when the agent tries to finish a task that changed
//                      files, the owner's named check script is run and the
//                      stop is refused, with the failure as the reason, until
//                      it exits 0, the attempt budget is spent, or the check
//                      cannot run at all.
//
// What counts as proof: the script's real exit code, 0, run now against this
// working tree, from a script whose raw bytes match what a person enrolled with
// `/cockpit guard trust` (kept in the plugin store, per project and path, across
// sessions; never enrolled by a model, a plugin or a configuration alone) and,
// when set, the pinned hash. The tree must not have moved while it ran. The
// agent that is being checked must not be able to edit its own judge. Never a model's sentence and never a prompt: the script is named
// only in the plugin's own options and is run as an argv, not through a shell.
// Whether a project-scoped settings file can supply plugin options is a host
// property this plugin does not control; pin the hash when the repository is
// not yours. A passing script establishes the TEST gate and nothing else: it does
// not clear a mandatory Opus review or release approval, and Cockpit commits,
// pushes and releases nothing.
//
// When the budget is spent, or the check cannot run, the stop is allowed (a
// human can always end a session) and the task is BLOCKED with the last
// reason, never DONE.

import type { Task } from '../types'
import { holdTask, oneLine, uidOf } from './model'
export { uidOf }

export type Policy = 'OBSERVE' | 'ENFORCE'
export const MAX_ATTEMPTS_CEILING = 10
export const TIMEOUT_CEILING_MS = 900_000
export const MIN_SUMMARY_CHARS = 60

export type StopConfig = {
  policy: Policy
  /** Absolute path of the owner's check script, or null. */
  script: string | null
  /** Optional sha-256 the script must have (hex), or null. */
  pin: string | null
  timeoutMs: number
  maxAttempts: number
  /**
   * Operator-authorized prefixes (relative to the repository, ending in /) whose IGNORED entries do not count in the fingerprint:
   * dependency caches, build output, temporary logs. They never exclude a tracked or untracked file, and never the verifier.
   */
  volatile: string[]
  /** Operator-listed paths whose content is hashed into the fingerprint whatever git says about them (ignored configs, a verifier's dependencies). */
  watch: string[]
  /** Why the configuration is not usable, one line each. */
  problems: string[]
}

const listOf = (raw: unknown): string[] => (typeof raw === 'string' ? raw.split(',').map(x => x.trim()).filter(Boolean).slice(0, 64) : [])

/** A volatile prefix: relative, a directory, no traversal, not git's own, and not covering the root. */
export const volatileOf = (raw: unknown): string[] =>
  listOf(raw).filter(x => /^[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*\/$/.test(x) && !x.split('/').some(part => part === '.' || part === '..' || part === '.git') && x.length <= 200)

/** A watched path: no traversal or control characters; relative to the repository or absolute. */
export const watchOf = (raw: unknown): string[] => listOf(raw).filter(x => x.length <= 300 && !/[\0\r\n]/.test(x) && !x.split('/').some(part => part === '..'))

const clampInt = (x: unknown, lo: number, hi: number, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : fallback)

/** The path with ~ expanded against `home`, or null when it is not an acceptable absolute path. */
export const scriptPathOf = (raw: unknown, home: string | null): string | null => {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || text.length > 512 || /[\0\r\n]/.test(text)) return null
  const full = text.startsWith('~/') ? (home !== null && home.startsWith('/') ? `${home.replace(/\/+$/, '')}/${text.slice(2)}` : null) : text
  if (full === null || !full.startsWith('/') || full.endsWith('/')) return null
  if (full.split('/').some(part => part === '..' || part === '.')) return null

  return full
}

export const configOf = (options: Readonly<Record<string, unknown>>, home: string | null): StopConfig => {
  const problems: string[] = []
  // Only an absent value or exactly OBSERVE is OBSERVE. Anything else is an attempt at ENFORCE that was not understood, and it
  // stays ENFORCE with a stated problem: a typo must not quietly turn the owner's verification off.
  const rawPolicy = options['stopGuard']
  const isObserve = rawPolicy === undefined || rawPolicy === null || rawPolicy === 'OBSERVE' || (typeof rawPolicy === 'string' && rawPolicy.trim() === '')
  const policy: Policy = isObserve ? 'OBSERVE' : 'ENFORCE'
  if (!isObserve && rawPolicy !== 'ENFORCE') problems.push('stopGuard must be exactly OBSERVE or ENFORCE; the value given was not understood, so verification stays required and stops are refused until it is fixed')
  const rawScript = options['verifyScript']
  const isScriptGiven = rawScript !== undefined && rawScript !== null && !(typeof rawScript === 'string' && rawScript.trim() === '')
  const script = typeof rawScript === 'string' && isScriptGiven ? scriptPathOf(rawScript, home) : null
  if (isScriptGiven && script === null) problems.push('verifyScript must be an absolute path (or ~/…) with no "..", no newline and no trailing slash')
  const rawPin = options['verifyScriptSha256']
  const pin = typeof rawPin === 'string' && /^[0-9a-f]{64}$/i.test(rawPin.trim()) ? rawPin.trim().toLowerCase() : null
  if (rawPin !== undefined && rawPin !== null && !(typeof rawPin === 'string' && rawPin.trim() === '') && pin === null) problems.push('verifyScriptSha256 must be 64 hex characters')
  if (policy === 'ENFORCE' && script === null && problems.length === 0) problems.push('ENFORCE needs verifyScript: with no named check there is nothing to enforce, so stops are allowed')

  return {
    policy, script, pin,
    timeoutMs: clampInt((typeof options['verifyTimeoutSec'] === 'number' ? options['verifyTimeoutSec'] * 1000 : undefined), 1000, TIMEOUT_CEILING_MS, 120_000),
    maxAttempts: clampInt(options['stopMaxContinuations'], 1, MAX_ATTEMPTS_CEILING, 3),
    // a volatile prefix never covers the verifier or a watched path: that exclusion would hide what the check stands on
    volatile: volatileOf(options['stopVolatile']).filter(v => !(script?.includes(`/${v}`) ?? false) && !watchOf(options['stopWatch']).some(w => w.startsWith(v))),
    watch: watchOf(options['stopWatch']),
    problems,
  }
}

export type Outcome = 'pass' | 'fail' | 'timeout' | 'error' | 'missing' | 'untrusted' | 'unstable' | 'released' | 'unchanged'
export const OUTCOMES: readonly Outcome[] = ['pass', 'fail', 'timeout', 'error', 'missing', 'untrusted', 'unstable', 'released', 'unchanged']
export type CheckRecord = {
  taskId: number
  /** Which task, across resets and restarts: task numbers start again at 1, this does not. */
  uid: string
  /** Which verifier ran: a short hash of the project and script path. A task keeps the verifier it started with. */
  verifier: string
  /** The check passed AND completion was allowed (a summary was given). Only this ends a run of attempts. */
  complete: boolean
  /** The script's file name only; the path is not kept. */
  name: string
  /** First 8 hex of the sha-256 of the script as run; null when it could not be read. */
  sha: string | null
  at: number
  outcome: Outcome
  /** The process's real exit code; null when it did not exit (timeout, not run). */
  exit: number | null
  ms: number | null
  /** The working-tree fingerprint the run was made against, when git could give one. */
  tree: string | null
  /** A short, redacted, bounded tail of the check's output; a description of a failure, never proof of success. */
  summary: string
  /** Whether the closing message carried a change summary of a useful length. */
  hasSummary: boolean
}

/** Whether this task changed anything a check could be about. */
export const hasChanges = (task: Task | null): boolean => task !== null && (task.edited === true || task.files.length > 0 || task.kind === 'coding')

/**
 * The attempts already spent on this task: every check since the last one that completed it. A passing check that
 * still left completion refused (no summary) is an attempt like any other; it never resets the budget.
 */
export const attemptsOf = (checks: readonly CheckRecord[], uid: string): number => {
  let n = 0
  for (const c of [...checks].reverse()) {
    if (c.uid !== uid) continue
    if (c.complete) break
    n++
  }

  return n
}

/** A closing message of useful length. When the host did not give the message at all, nothing is known and nothing is required. */
export const hasChangeSummary = (message: string | undefined): boolean => message === undefined || message.trim().length >= MIN_SUMMARY_CHARS

const isText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max
/** Whether a stored record has exactly the shape this build writes. A malformed one is dropped, never believed. */
export const isCheckRecord = (x: unknown): x is CheckRecord => {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>

  return Number.isSafeInteger(r['taskId']) && isText(r['uid'], 64) && isText(r['verifier'], 32) && typeof r['complete'] === 'boolean' && isText(r['name'], 160)
    && (r['sha'] === null || isText(r['sha'], 16)) && typeof r['at'] === 'number' && OUTCOMES.includes(r['outcome'] as Outcome)
    && (r['exit'] === null || Number.isSafeInteger(r['exit'])) && (r['ms'] === null || typeof r['ms'] === 'number') && (r['tree'] === null || isText(r['tree'], 96))
    && isText(r['summary'], 700) && typeof r['hasSummary'] === 'boolean'
}
export const validChecks = (x: unknown): CheckRecord[] => (Array.isArray(x) ? x.filter(isCheckRecord).slice(-24) : [])

/** The tail of a check's output, one line, bounded; the caller redacts secrets first. */
export const outputTail = (output: string): string => {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)

  return oneLine(lines.slice(-6).join(' | '), 600)
}

export type Verdict =
  | { action: 'allow'; state: 'VERIFIED' | 'NOTHING_TO_CHECK' | 'IDLE' }
  | { action: 'allow'; state: 'BLOCKED'; reason: string }
  | { action: 'block'; reason: string; attempt: number }

export type VerdictInput = {
  cfg: StopConfig
  /** Failing attempts already spent on this task, before this one. */
  spent: number
  /** The result of the run just made; null when it was not made. */
  run: CheckRecord | null
  hasSummary: boolean
}

/** What the Stop hook answers, given the run. Pure. */
export const verdictOf = (v: VerdictInput): Verdict => {
  const { cfg, run } = v
  if (run === null) return { action: 'allow', state: 'IDLE' }
  const left = cfg.maxAttempts - v.spent - 1
  const attempt = v.spent + 1
  const describe = (head: string) => `${head}${run.summary === '' ? '' : ` Check output: ${run.summary}`}`
  switch (run.outcome) {
    case 'pass':
      if (!v.hasSummary) {
        return left > 0
          ? { action: 'block', attempt, reason: `Your verification check passed (exit 0), but your closing message does not summarize what you changed. Finish with a short factual summary of the changes. A summary is not evidence and does not replace the check. (attempt ${attempt} of ${cfg.maxAttempts})` }
          : { action: 'allow', state: 'BLOCKED', reason: 'the check passed but no change summary was given' }
      }

      return { action: 'allow', state: 'VERIFIED' }
    case 'fail':
    case 'timeout': {
      const head = run.outcome === 'timeout'
        ? `The verification check "${run.name}" did not finish within ${Math.round(cfg.timeoutMs / 1000)}s and is treated as failed.`
        : `The verification check "${run.name}" failed with exit code ${run.exit}.`
      if (left > 0) return { action: 'block', attempt, reason: `${describe(head)} Fix the cause, make sure the check exits 0, then finish. Do not claim the work is verified until it does. (attempt ${attempt} of ${cfg.maxAttempts})` }

      return { action: 'allow', state: 'BLOCKED', reason: `${run.outcome === 'timeout' ? 'check timed out' : `check exit ${run.exit}`} after ${cfg.maxAttempts} attempt${cfg.maxAttempts === 1 ? '' : 's'}${run.summary === '' ? '' : `: ${run.summary}`}` }
    }
    case 'unstable':
      return left > 0
        ? { action: 'block', attempt, reason: `Files changed while the verification check "${run.name}" ran, so its result says nothing about the final state. Make your changes first, then finish again so it can run on a still tree. (attempt ${attempt} of ${cfg.maxAttempts})` }
        : { action: 'allow', state: 'BLOCKED', reason: `files kept changing while the check ran, after ${cfg.maxAttempts} attempt${cfg.maxAttempts === 1 ? '' : 's'}` }
    case 'untrusted':
      return { action: 'allow', state: 'BLOCKED', reason: `the check script is not trusted${run.summary === '' ? '' : ` (${run.summary})`}; a person must review it and run /cockpit guard trust` }
    case 'missing':
      return { action: 'allow', state: 'BLOCKED', reason: 'the configured check script is missing or not runnable' }
    default:
      return { action: 'allow', state: 'BLOCKED', reason: `the check could not be run${run.summary === '' ? '' : `: ${run.summary}`}` }
  }
}

export const boundedChecks = (checks: readonly CheckRecord[], add: CheckRecord, cap = 24): CheckRecord[] => [...checks, add].slice(-cap)

const PREFIX = /^STOP GUARD: /

/**
 * Settles the protected Stop guard state of a task saved before it was a field of its own (guardSchema absent). Run once per
 * task, and again harmlessly: a settled task is returned as it is.
 *
 * Evidence is the guard's own check records in the Run Ledger, which the model cannot write, never the blocker text, which it can:
 *  - a non-complete record for this task AND the guard's blocker, or the budget spent, or a check that could not run: HELD;
 *  - a guard blocker whose records all completed, or whose records were unreadable: HELD as ambiguous (needs a fresh check or
 *    a person's release; nothing is granted);
 *  - a guard-looking blocker with no record at all is an ordinary blocker and stays one;
 *  - everything else (OBSERVE, completed, other blockers, failed gates) is unchanged.
 * No script trust is invented: trust lives in its own store and is not read from here.
 */
export const migrateStopHold = (task: Task, checks: readonly CheckRecord[], dropped: number, maxAttempts: number, now: number): Task => {
  if (task.guardSchema === 1) return task
  const settled: Task = { ...task, guardSchema: 1 }
  if (task.stopHold !== undefined) return settled
  const uid = uidOf(task)
  const mine = checks.filter(c => c.uid === uid && c.outcome !== 'released')
  const last = mine.at(-1)
  const looksHeld = task.blocker !== null && PREFIX.test(task.blocker)
  const reason = looksHeld ? (task.blocker as string).replace(PREFIX, '') : null
  const spent = attemptsOf(checks, uid)
  if (last === undefined) {
    // no record: a forged or foreign blocker is ordinary, unless records were lost, when it cannot be told apart
    return looksHeld && dropped > 0 ? holdTask(settled, 'legacy Stop guard state could not be read; run the check again or release it', 0, now) : settled
  }
  if (last.complete) return looksHeld ? holdTask(settled, `legacy state is ambiguous (${reason}); run the check again or release it`, spent, now) : settled
  if (looksHeld || spent >= maxAttempts || last.outcome === 'error' || last.outcome === 'untrusted') {
    return holdTask(settled, reason ?? (last.outcome === 'error' || last.outcome === 'untrusted' ? `legacy check ${last.outcome}` : 'the refusal budget was spent before this version'), spent, now)
  }

  return settled
}

/** What a fingerprint comparison proves. UNKNOWN is never read as UNCHANGED, and it is not read as CHANGED either. */
export type TreeVerdict = 'UNCHANGED' | 'CHANGED' | 'UNKNOWN'

/** The project identity a fingerprint was taken in (`@id`), absent from fingerprints saved by v0.5.2. */
const projectOf = (stamp: string): string | null => (stamp.includes('@') ? stamp.slice(stamp.lastIndexOf('@') + 1) : null)

/**
 * A fingerprint is only comparable with one taken in the same project: another checkout, worktree or repository, or a
 * fingerprint from a build that did not record the project, is UNKNOWN (the check runs), never UNCHANGED.
 */
export const compareTree = (start: string | null | undefined, now: string | null): TreeVerdict =>
  typeof start !== 'string' || now === null ? 'UNKNOWN' : projectOf(start) !== projectOf(now) ? 'UNKNOWN' : start === now ? 'UNCHANGED' : 'CHANGED'
