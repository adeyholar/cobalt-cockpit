// Cobalt Guard: opt-in owner alerting for failures that need a person.
//
// A local policy over events Cockpit already observes: it decides whether an
// alert is due, never what is true. It reads the verification state; it writes
// none. Raising an alert does not change a gate, a review hold or a release
// approval, and an alert that fails to send changes nothing either: a task
// that was BLOCKED stays BLOCKED.
//
// Delivery is the host's own `$.ui.notify`, the person's terminal notification
// channel (iTerm2, kitty, Ghostty or the bell). It writes to the terminal and
// cannot be confirmed: the host says a dropped sequence "still reads true". So
// the states are ATTEMPTED (a send was made) and SENT (the host said it wrote
// it), never DELIVERED. No webhook, email, pager or push is implemented.
//
// Nothing here carries a prompt, code, path, command or secret: a message is
// built from a closed vocabulary and a task number.

export type AlertKind = 'verification-exhausted' | 'security-failure' | 'release-no-go' | 'review-hold' | 'run-blocked'
export type AlertOutcome = 'sent' | 'failed' | 'refused' | 'throttled' | 'silenced'
export const KINDS: readonly AlertKind[] = ['verification-exhausted', 'security-failure', 'release-no-go', 'review-hold', 'run-blocked']

export type GuardConfig = { enabled: boolean; cooldownMs: number; maxPerSession: number }
export const COOLDOWN_DEFAULT_SEC = 300
export const MAX_DEFAULT = 5
export const MAX_CEILING = 20
export const ALERT_CAP = 32

const clamp = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d)

export const guardConfigOf = (options: Readonly<Record<string, unknown>>): GuardConfig => ({
  enabled: options['guardAlerts'] === true,
  cooldownMs: clamp(options['guardCooldownSec'], 30, 86_400, COOLDOWN_DEFAULT_SEC) * 1000,
  maxPerSession: clamp(options['guardMaxAlerts'], 1, MAX_CEILING, MAX_DEFAULT),
})

/** One alert as the Run Ledger keeps it: closed vocabulary and numbers only. */
export type AlertRecord = { key: string; kind: AlertKind; taskId: number; at: number; outcome: AlertOutcome; attempts: number; channel: string | null; why?: 'disabled' | 'no-channel' | 'no-surface' | 'refused' | 'error'; acked?: true }

export type GuardState = { sentAt: number | null; count: number; silenced: string[]; all: boolean; pending: boolean }
export const EMPTY_GUARD: GuardState = { sentAt: null, count: 0, silenced: [], all: false, pending: false }

/** The facts the policy reads, all of them already observed elsewhere. */
export type Facts = {
  taskId: number
  /** The TEST/SECURITY gates as the task holds them. */
  securityFailed: boolean
  /** The Stop guard exhausted its attempts or could not run its check. */
  stopBlocker: string | null
  /** The task is blocked for another reason (a milestone or the task). */
  blocker: string | null
  /** A release consultation returned NO-GO and is not superseded. */
  releaseNoGo: boolean
  /** A mandatory review is required and not adjudicated. */
  reviewOpen: boolean
  /** Only at an attempted stop of the run. */
  atStop: boolean
}

/** A blocker is "retries exhausted" only when a check really ran and kept failing; a missing, changed or unstartable script is a blocked run. */
export const exhaustedBlocker = (blocker: string | null): string | null => (blocker !== null && /^STOP GUARD: check (?:exit|timed out)/.test(blocker) ? blocker : null)

export const keyOf = (taskId: number, kind: AlertKind, detail: string): string => `${taskId}:${kind}:${detail}`

/** The conditions that call for a person, in the order they are told. A recoverable failure is not among them. */
export const dueOf = (f: Facts): { kind: AlertKind; key: string }[] => {
  const out: { kind: AlertKind; key: string }[] = []
  if (f.securityFailed) out.push({ kind: 'security-failure', key: keyOf(f.taskId, 'security-failure', 'SECURITY') })
  if (f.releaseNoGo) out.push({ kind: 'release-no-go', key: keyOf(f.taskId, 'release-no-go', 'release') })
  if (f.stopBlocker !== null) out.push({ kind: 'verification-exhausted', key: keyOf(f.taskId, 'verification-exhausted', 'TEST') })
  else if (f.blocker !== null) out.push({ kind: 'run-blocked', key: keyOf(f.taskId, 'run-blocked', 'task') })
  if (f.atStop && f.reviewOpen) out.push({ kind: 'review-hold', key: keyOf(f.taskId, 'review-hold', 'review') })

  return out
}

export type Decision = { send: true } | { send: false; why: 'off' | 'duplicate' | 'silenced' | 'throttled' | 'budget' }

/** Whether this one alert is sent now. Pure: the caller keeps the state. */
export const decide = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[], key: string, now: number): Decision => {
  if (!cfg.enabled) return { send: false, why: 'off' }
  if (state.all || state.silenced.includes(key)) return { send: false, why: 'silenced' }
  if (kept.some(a => a.key === key && a.outcome !== 'throttled' && a.outcome !== 'silenced')) return { send: false, why: 'duplicate' }
  if (state.count >= cfg.maxPerSession) return { send: false, why: 'budget' }
  if (state.sentAt !== null && now - state.sentAt < cfg.cooldownMs) return { send: false, why: 'throttled' }

  return { send: true }
}

const HEAD: Record<AlertKind, string> = {
  'verification-exhausted': 'verification kept failing and the retry budget is spent',
  'security-failure': 'a security check failed; the task cannot be called verified',
  'release-no-go': 'the release review said NO-GO; the release is held',
  'review-hold': 'a mandatory review is still open; the run cannot finish',
  'run-blocked': 'the run is blocked and needs you',
}

/** The whole text of an alert. A closed vocabulary plus a task number: no prompt, code, path, command or secret can be in it. */
export const messageOf = (kind: AlertKind, taskId: number): string => `Cobalt Guard · task ${taskId}: ${HEAD[kind]}. Nothing was approved or released. /cockpit guard`

export const labelOf = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[]): 'OFF' | 'ARMED' | 'ALERT PENDING' | 'SENT' | 'FAILED' => {
  if (!cfg.enabled) return 'OFF'
  if (state.pending) return 'ALERT PENDING'
  const last = [...kept].reverse().find(a => a.outcome === 'sent' || a.outcome === 'failed' || a.outcome === 'refused')
  if (last === undefined || last.acked === true) return 'ARMED'

  return last.outcome === 'sent' ? 'SENT' : 'FAILED'
}

export const bounded = (kept: readonly AlertRecord[], add: AlertRecord): AlertRecord[] => [...kept, add].slice(-ALERT_CAP)

export const guardText = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[]): string => {
  const lines = [`GUARD: ${labelOf(cfg, state, kept)}`]
  if (!cfg.enabled) lines.push('Off. Set guardAlerts to true to be told when a run needs you. Nothing is sent while off.')
  else {
    lines.push(`Armed · ${state.count} of ${cfg.maxPerSession} alerts used this session · at most one every ${Math.round(cfg.cooldownMs / 1000)}s · same condition never twice.`)
    lines.push('Delivery: your terminal notification channel, through the host. SENT means the host wrote it to your terminal; it cannot confirm that you saw it. No webhook, email or push exists in this version.')
  }
  for (const a of kept.slice(-5)) lines.push(`  ${a.kind} · task ${a.taskId} · ${a.outcome}${a.channel === null ? (a.why === undefined ? '' : ` (${a.why})`) : ` via ${a.channel}`}${a.acked === true ? ' · acknowledged' : ''}`)
  lines.push('An alert never clears a review hold, approves a release or changes a verdict. /cockpit guard ack acknowledges; /cockpit guard silence mutes this session.')

  return lines.join('\n')
}
