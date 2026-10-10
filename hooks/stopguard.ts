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
// working tree, from a script whose content is unchanged since the session
// began (the agent that is being checked must not be able to edit its own
// judge). Never a model's sentence, never a prompt, never repository metadata:
// the script is named only in the owner's own plugin options, a project
// settings file may not enable this, and it is run as an argv, not through a
// shell. A passing script establishes the TEST gate and nothing else: it does
// not clear a mandatory Opus review or release approval, and Cockpit commits,
// pushes and releases nothing.
//
// When the budget is spent, or the check cannot run, the stop is allowed (a
// human can always end a session) and the task is BLOCKED with the last
// reason, never DONE.

import type { Task } from '../types'
import { oneLine } from './model'

export type Policy = 'OBSERVE' | 'ENFORCE'
export const MAX_ATTEMPTS_CEILING = 10
export const TIMEOUT_CEILING_MS = 900_000
export const MIN_SUMMARY_CHARS = 60
export const BLOCKER_PREFIX = 'STOP GUARD: '

export type StopConfig = {
  policy: Policy
  /** Absolute path of the owner's check script, or null. */
  script: string | null
  /** Optional sha-256 the script must have (hex), or null. */
  pin: string | null
  timeoutMs: number
  maxAttempts: number
  /** Why the configuration is not usable, one line each. */
  problems: string[]
}

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
  const policy: Policy = options['stopGuard'] === 'ENFORCE' ? 'ENFORCE' : 'OBSERVE'
  const rawScript = options['verifyScript']
  const script = typeof rawScript === 'string' && rawScript.trim() !== '' ? scriptPathOf(rawScript, home) : null
  if (typeof rawScript === 'string' && rawScript.trim() !== '' && script === null) problems.push('verifyScript must be an absolute path (or ~/…) with no "..", no newline and no trailing slash')
  const rawPin = options['verifyScriptSha256']
  const pin = typeof rawPin === 'string' && /^[0-9a-f]{64}$/i.test(rawPin.trim()) ? rawPin.trim().toLowerCase() : null
  if (typeof rawPin === 'string' && rawPin.trim() !== '' && pin === null) problems.push('verifyScriptSha256 must be 64 hex characters')
  if (policy === 'ENFORCE' && script === null && problems.length === 0) problems.push('ENFORCE needs verifyScript: with no named check there is nothing to enforce, so stops are allowed')

  return {
    policy, script, pin,
    timeoutMs: clampInt((typeof options['verifyTimeoutSec'] === 'number' ? options['verifyTimeoutSec'] * 1000 : undefined), 1000, TIMEOUT_CEILING_MS, 120_000),
    maxAttempts: clampInt(options['stopMaxContinuations'], 1, MAX_ATTEMPTS_CEILING, 3),
    problems,
  }
}

export type Outcome = 'pass' | 'fail' | 'timeout' | 'error' | 'missing' | 'untrusted'
export type CheckRecord = {
  taskId: number
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

/** The attempts already spent on this task: failing records since its last pass. */
export const attemptsOf = (checks: readonly CheckRecord[], taskId: number): number => {
  let n = 0
  for (const c of [...checks].reverse()) {
    if (c.taskId !== taskId) continue
    if (c.outcome === 'pass') break
    n++
  }

  return n
}

export const hasChangeSummary = (message: string | undefined): boolean => (message ?? '').trim().length >= MIN_SUMMARY_CHARS

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
    case 'untrusted':
      return { action: 'allow', state: 'BLOCKED', reason: 'the check script changed during this session or does not match its pin, so its result is not trusted; the owner must review and re-trust it' }
    case 'missing':
      return { action: 'allow', state: 'BLOCKED', reason: 'the configured check script is missing or not runnable' }
    default:
      return { action: 'allow', state: 'BLOCKED', reason: `the check could not be run${run.summary === '' ? '' : `: ${run.summary}`}` }
  }
}

export const boundedChecks = (checks: readonly CheckRecord[], add: CheckRecord, cap = 24): CheckRecord[] => [...checks, add].slice(-cap)
