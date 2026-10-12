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
//
// Persistent alerts (v0.5.4, `guardRepeat`, off by default) add a lifecycle to
// an alert that was raised: while its condition is still open it is repeated,
// a bounded number of times, inside the same cooldown and session budget; an
// acknowledgment or a silence ends the repeats; a condition that no longer
// holds is recorded as resolved. All of it is read off the kept records, so a
// reload or a restart resumes the count instead of starting it again.
//
// Priorities, kinds and quiet hours (v0.5.6) decide only whether and when a condition is told, never whether it holds.
// Each kind has one fixed level. A kind the operator turned off, and an alert quiet hours hold back, is recorded and
// stays on the HUD: nothing that is still open is dropped without a trace. The order alerts are told in is unchanged.

import { isHeld, isQuiet, machineZone, quietConfigOf, quietLines } from './quiet'
import type { QuietConfig } from './quiet'

export type AlertKind = 'verification-exhausted' | 'security-failure' | 'release-no-go' | 'review-hold' | 'run-blocked'
export type AlertOutcome = 'sent' | 'failed' | 'refused' | 'throttled' | 'silenced' | 'resolved' | 'deferred'
export const KINDS: readonly AlertKind[] = ['verification-exhausted', 'security-failure', 'release-no-go', 'review-hold', 'run-blocked']

/** One fixed level per kind. CRITICAL is the class quiet hours treat apart; the levels order the HUD, not the sending. */
export type Level = 'CRITICAL' | 'HIGH' | 'NORMAL'
export const LEVEL: Readonly<Record<AlertKind, Level>> = { 'security-failure': 'CRITICAL', 'release-no-go': 'HIGH', 'verification-exhausted': 'HIGH', 'review-hold': 'HIGH', 'run-blocked': 'NORMAL' }
/** Highest first; within a level, the order the kinds have always been told in. */
export const PRIORITY: readonly AlertKind[] = ['security-failure', 'release-no-go', 'verification-exhausted', 'review-hold', 'run-blocked']
export const isCritical = (kind: AlertKind): boolean => LEVEL[kind] === 'CRITICAL'
export const byPriority = (a: AlertKind, b: AlertKind): number => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)

export type GuardConfig = {
  enabled: boolean; cooldownMs: number; maxPerSession: number; repeat: boolean; repeatMs: number; maxReminders: number; sound: boolean
  /** The kinds a notification is sent for (`guardNotifyKinds`); a critical kind is always among them. */
  kinds: readonly AlertKind[]
  /** What in `guardNotifyKinds` was not understood. Closed sentences. */
  kindProblems: string[]
  quiet: QuietConfig
}
export const COOLDOWN_DEFAULT_SEC = 300
export const MAX_DEFAULT = 5
export const MAX_CEILING = 20
export const ALERT_CAP = 32
export const REPEAT_DEFAULT_SEC = 900
export const REMINDERS_DEFAULT = 3
export const REMINDERS_CEILING = 10

const clamp = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d)

/**
 * The kinds that are notified, from a comma-separated list of kind names (empty or `all`: every kind; `none`: only the
 * critical one). A critical kind cannot be turned off. A list that was not understood notifies every kind, and says so.
 */
export const kindsOf = (x: unknown): { kinds: readonly AlertKind[]; problems: string[] } => {
  if (x === undefined || x === null) return { kinds: KINDS, problems: [] }
  if (typeof x !== 'string') return { kinds: KINDS, problems: ['guardNotifyKinds is not a list of kind names, so every kind is notified'] }
  const words = x.toLowerCase().split(/[\s,]+/).filter(w => w !== '')
  const unknown = words.filter(w => w !== 'all' && w !== 'none' && !KINDS.includes(w as AlertKind)).length
  const named = KINDS.filter(k => words.includes(k))
  if (words.length === 0 || words.includes('all')) return { kinds: KINDS, problems: unknown > 0 ? [`guardNotifyKinds names ${unknown} kind${unknown === 1 ? '' : 's'} Cockpit does not know; ${unknown === 1 ? 'it was' : 'they were'} ignored`] : [] }
  if (named.length === 0 && !words.includes('none')) return { kinds: KINDS, problems: ['guardNotifyKinds names no kind Cockpit knows, so every kind is notified'] }

  return { kinds: KINDS.filter(k => isCritical(k) || named.includes(k)), problems: unknown > 0 ? [`guardNotifyKinds names ${unknown} kind${unknown === 1 ? '' : 's'} Cockpit does not know; ${unknown === 1 ? 'it was' : 'they were'} ignored`] : [] }
}

export const guardConfigOf = (options: Readonly<Record<string, unknown>>, zone: string = machineZone()): GuardConfig => ({
  enabled: options['guardAlerts'] === true,
  cooldownMs: clamp(options['guardCooldownSec'], 30, 86_400, COOLDOWN_DEFAULT_SEC) * 1000,
  maxPerSession: clamp(options['guardMaxAlerts'], 1, MAX_CEILING, MAX_DEFAULT),
  // persistence and sound are each their own switch, and neither does anything while the alerts themselves are off
  repeat: options['guardAlerts'] === true && options['guardRepeat'] === true,
  repeatMs: clamp(options['guardRepeatSec'], 60, 86_400, REPEAT_DEFAULT_SEC) * 1000,
  maxReminders: clamp(options['guardMaxReminders'], 1, REMINDERS_CEILING, REMINDERS_DEFAULT),
  sound: options['guardAlerts'] === true && options['guardSound'] === true,
  kinds: kindsOf(options['guardNotifyKinds']).kinds,
  kindProblems: options['guardAlerts'] === true ? kindsOf(options['guardNotifyKinds']).problems : [],
  quiet: quietConfigOf(options, zone),
})

/** One alert as the Run Ledger keeps it: closed vocabulary and numbers only. */
export type AlertRecord = { key: string; kind: AlertKind; taskId: number; at: number; outcome: AlertOutcome; attempts: number; channel: string | null; why?: Why; acked?: true; /** Which reminder of its condition this is; absent on the first alert. */ nth?: number; /** The audible cue a player exited 0 for: ATTEMPTED, never heard. */ cue?: Cue }
export type Cue = 'sound' | 'bell'
export type Why = 'disabled' | 'no-channel' | 'no-surface' | 'refused' | 'error' | 'cooldown' | 'budget' | 'quiet' | 'kind-off'
export const RETRY_CAP = 3

export type GuardState = { sentAt: number | null; count: number; silenced: string[]; all: boolean; pending: boolean; /** When the person last acknowledged: a notice still being written at that moment is acknowledged too. */ ackAt?: number }
export const EMPTY_GUARD: GuardState = { sentAt: null, count: 0, silenced: [], all: false, pending: false }

/** The facts the policy reads, all of them already observed elsewhere. */
export type Facts = {
  /** The task's identity across resets and restarts; task numbers start again at 1 and must not repeat a dedupe key. */
  taskUid: string
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

/** A hold is "retries exhausted" only when a check really ran and kept failing; a missing, changed or unstartable script is a blocked run. */
export const exhaustedBlocker = (reason: string | null): string | null => (reason !== null && /^check (?:exit|timed out)/.test(reason) ? reason : null)

export const keyOf = (taskUid: string, kind: AlertKind, detail: string): string => `${taskUid}:${kind}:${detail}`

/** The conditions that call for a person, in the order they are told. A recoverable failure is not among them. */
export const dueOf = (f: Facts): { kind: AlertKind; key: string }[] => {
  const out: { kind: AlertKind; key: string }[] = []
  if (f.securityFailed) out.push({ kind: 'security-failure', key: keyOf(f.taskUid, 'security-failure', 'SECURITY') })
  if (f.releaseNoGo) out.push({ kind: 'release-no-go', key: keyOf(f.taskUid, 'release-no-go', 'release') })
  if (f.stopBlocker !== null) out.push({ kind: 'verification-exhausted', key: keyOf(f.taskUid, 'verification-exhausted', 'TEST') })
  else if (f.blocker !== null) out.push({ kind: 'run-blocked', key: keyOf(f.taskUid, 'run-blocked', 'task') })
  if (f.atStop && f.reviewOpen) out.push({ kind: 'review-hold', key: keyOf(f.taskUid, 'review-hold', 'review') })

  return out
}

export type Decision = { send: true; attempts: number } | { send: false; why: 'off' | 'duplicate' | 'silenced' | 'throttled' | 'budget' | 'gave-up' }

const isNotice = (a: AlertRecord): boolean => a.outcome === 'sent' || a.outcome === 'failed' || a.outcome === 'refused'

/** The records of a condition's current occurrence: those kept after it was last recorded as resolved. */
export const episodeOf = (kept: readonly AlertRecord[], key: string): AlertRecord[] => {
  const mine = kept.filter(a => a.key === key)
  const closed = mine.map(a => a.outcome).lastIndexOf('resolved')

  return closed < 0 ? mine : mine.slice(closed + 1)
}

/** Whether this one alert is sent now. Pure: the caller keeps the state. */
export const decide = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[], key: string, now: number): Decision => {
  if (!cfg.enabled) return { send: false, why: 'off' }
  if (state.all || state.silenced.includes(key)) return { send: false, why: 'silenced' }
  // a condition that was resolved and holds again is a new occurrence; `resolved` is only ever written by persistent alerts
  const run = episodeOf(kept, key)
  // only a notification the host wrote ends the matter; a failed or refused one may be tried again, a bounded number of times
  if (run.some(a => a.outcome === 'sent')) return { send: false, why: 'duplicate' }
  const failed = run.filter(a => a.outcome === 'failed' || a.outcome === 'refused').length
  if (failed >= RETRY_CAP) return { send: false, why: 'gave-up' }
  if (state.count >= cfg.maxPerSession) return { send: false, why: 'budget' }
  if (state.sentAt !== null && now - state.sentAt < cfg.cooldownMs) return { send: false, why: 'throttled' }

  return { send: true, attempts: failed + 1 }
}

export type Reminder = { send: true; nth: number } | { send: false; why: 'off' | 'silenced' | 'not-alerted' | 'acknowledged' | 'spent' | 'budget' | 'waiting' | 'throttled' }

/**
 * Whether a condition that was already alerted, and is still open, is repeated now. Pure, and bounded four ways: the
 * reminders one condition may have, the session's alert budget, the interval since its last notice and the cooldown
 * between any two alerts. An acknowledgment ends it for good; a reminder that failed to send counts as one; and the
 * budget's last alert is never a reminder's.
 */
export const remind = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[], key: string, now: number): Reminder => {
  if (!cfg.enabled || !cfg.repeat) return { send: false, why: 'off' }
  if (state.all || state.silenced.includes(key)) return { send: false, why: 'silenced' }
  const run = episodeOf(kept, key)
  if (!run.some(a => a.outcome === 'sent')) return { send: false, why: 'not-alerted' }
  if (run.some(a => a.acked === true)) return { send: false, why: 'acknowledged' }
  const made = run.filter(a => a.nth !== undefined).length
  if (made >= cfg.maxReminders) return { send: false, why: 'spent' }
  // the session's last alert is kept for a condition that has not been told at all: a reminder never spends it
  if (state.count >= cfg.maxPerSession - 1) return { send: false, why: 'budget' }
  const last = Math.max(...run.filter(isNotice).map(a => a.at))
  // a clock that went backwards waits rather than fires
  if (!(now - last >= cfg.repeatMs)) return { send: false, why: 'waiting' }
  if (state.sentAt !== null && now - state.sentAt < cfg.cooldownMs) return { send: false, why: 'throttled' }

  return { send: true, nth: made + 1 }
}

/**
 * Why an alert that could otherwise be sent is held back now: its kind is turned off, or quiet hours hold its class.
 * Null when neither applies. Held back means no notification and no sound at all: nothing is written to the terminal.
 */
export const holdOf = (cfg: GuardConfig, kind: AlertKind, now: number): 'kind-off' | 'quiet' | null =>
  (!cfg.kinds.includes(kind) ? 'kind-off' : isHeld(cfg.quiet, isCritical(kind), now) ? 'quiet' : null)

const keysOf = (kept: readonly AlertRecord[]): string[] => [...new Set(kept.map(a => a.key))]
const wasDeferred = (run: readonly AlertRecord[]): boolean => run.some(a => a.outcome === 'deferred')
const wasSent = (run: readonly AlertRecord[]): boolean => run.some(a => a.outcome === 'sent')

/**
 * The conditions quiet hours held back that are still owed a notification: nothing was written for them yet, the
 * person has not acknowledged them meanwhile, and one can still come (the retries are not spent, and the condition was
 * not since silenced or its kind turned off). Oldest first, each with the record of its deferral.
 */
export const deferredOf = (kept: readonly AlertRecord[]): AlertRecord[] => {
  const out: AlertRecord[] = []
  for (const key of keysOf(kept)) {
    const run = episodeOf(kept, key)
    const first = run.find(a => a.outcome === 'deferred')
    const failed = run.filter(a => a.outcome === 'failed' || a.outcome === 'refused').length
    if (first !== undefined && !wasSent(run) && run.at(-1)?.acked !== true && run.at(-1)?.outcome !== 'silenced' && failed < RETRY_CAP) out.push(first)
  }

  return out
}

/** A deferred condition the person acknowledged before anything was sent: they know, so it is not announced afterwards. */
export const isSettledQuietly = (kept: readonly AlertRecord[], key: string): boolean => {
  const run = episodeOf(kept, key)

  return wasDeferred(run) && !wasSent(run) && run.at(-1)?.acked === true
}

/** The deferred conditions that no longer hold, acknowledged or not: each is recorded resolved once and never announced. */
export const lapsedOf = (kept: readonly AlertRecord[], open: readonly string[]): AlertRecord[] => {
  const out: AlertRecord[] = []
  for (const key of keysOf(kept)) {
    if (open.includes(key)) continue
    const run = episodeOf(kept, key)
    const first = run.find(a => a.outcome === 'deferred')
    if (first !== undefined && !run.some(isNotice)) out.push(first)
  }

  return out
}

/** Whether the timer still has something to look for: a reminder that may come due, or a deferred alert waiting for the window to end. */
export const hasWorkLeft = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[]): boolean =>
  cfg.enabled && (hasReminderLeft(cfg, state, kept) || (!state.all && state.count < cfg.maxPerSession && deferredOf(kept).length > 0))

/** The conditions a notice went out for and that are not recorded as resolved, oldest first, each with its first record. */
export const noticedOf = (kept: readonly AlertRecord[]): AlertRecord[] => {
  const out: AlertRecord[] = []
  for (const key of new Set(kept.map(a => a.key))) {
    const first = episodeOf(kept, key).find(isNotice)
    if (first !== undefined) out.push(first)
  }

  return out
}

/** The noticed conditions that no longer hold: `open` is every condition that holds now. Each is recorded resolved once. */
export const closedOf = (kept: readonly AlertRecord[], open: readonly string[]): AlertRecord[] => noticedOf(kept).filter(a => !open.includes(a.key))

/** Whether any condition could still be repeated: the only reason a reminder timer exists. */
export const hasReminderLeft = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[]): boolean =>
  noticedOf(kept).some(a => { const r = remind(cfg, state, kept, a.key, Number.MAX_SAFE_INTEGER); return r.send || r.why === 'throttled' })

const HEAD: Record<AlertKind, string> = {
  'verification-exhausted': 'verification kept failing and the retry budget is spent',
  'security-failure': 'a security check failed; the task cannot be called verified',
  'release-no-go': 'the release review said NO-GO; the release is held',
  'review-hold': 'a mandatory review is still open; the run cannot finish',
  'run-blocked': 'the run is blocked and needs you',
}

/** The whole text of an alert. A closed vocabulary plus a task number: no prompt, code, path, command or secret can be in it. */
export const messageOf = (kind: AlertKind, taskId: number): string => `Cobalt Guard · task ${taskId}: ${HEAD[kind]}. Nothing was approved or released. /cockpit guard`

/** After quiet hours, several held-back conditions are told in one notification: a count, the gravest one's closed sentence, and a task number. */
export const digestOf = (kinds: readonly AlertKind[], taskId: number): string =>
  `Cobalt Guard · task ${taskId}, quiet hours ended: ${kinds.length} conditions are still open; the first: ${HEAD[[...kinds].sort(byPriority)[0] ?? 'run-blocked']}. Nothing was approved or released. /cockpit guard`

/** A reminder's whole text: the same closed sentence, and two numbers. */
export const reminderOf = (kind: AlertKind, taskId: number, nth: number, max: number): string =>
  `Cobalt Guard · task ${taskId}, still open (reminder ${nth} of ${max}): ${HEAD[kind]}. Nothing was approved or released. /cockpit guard ack stops reminders`

export const labelOf = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[]): 'OFF' | 'ARMED' | 'ALERT PENDING' | 'SENT' | 'FAILED' => {
  if (!cfg.enabled) return 'OFF'
  if (state.pending) return 'ALERT PENDING'
  const last = [...kept].reverse().find(isNotice)
  if (last === undefined || last.acked === true) return 'ARMED'
  // its condition no longer holds: nothing is waiting on the person
  if (!episodeOf(kept, last.key).includes(last)) return 'ARMED'

  return last.outcome === 'sent' ? 'SENT' : 'FAILED'
}

/** Whether a notice was decided no later than the person's last acknowledgment, so it is born acknowledged. */
export const isAckedAt = (state: GuardState, at: number): boolean => typeof state.ackAt === 'number' && at <= state.ackAt

/**
 * Bounded, and when full it gives up the oldest held-back or silenced record first, so a written one is not pushed out by them.
 * Next go the records of an occurrence already resolved, oldest first and the `resolved` mark after what it closes, so an
 * open condition's alert, its reminder count and its acknowledgment are the last things forgotten.
 */
export const bounded = (kept: readonly AlertRecord[], add: AlertRecord): AlertRecord[] => {
  const all = [...kept, add]
  while (all.length > ALERT_CAP) {
    let drop = all.findIndex(a => a.outcome === 'throttled' || a.outcome === 'silenced')
    if (drop < 0 || drop >= all.length - 1) drop = all.findIndex((a, i) => a.outcome !== 'resolved' && all.some((b, j) => j > i && b.key === a.key && b.outcome === 'resolved'))
    if (drop < 0) drop = all.findIndex((a, i) => i < all.length - 1 && a.outcome === 'resolved')
    all.splice(drop >= 0 && drop < all.length - 1 ? drop : 0, 1)
  }

  return all
}

/** What the HUD pins and the status lists: a condition that holds now, was raised, and what became of its notification. */
export type PinStatus = 'sent' | 'not-sent' | 'deferred' | 'held' | 'kind-off' | 'silenced'
export type Pin = { key: string; kind: AlertKind; taskId: number; level: Level; status: PinStatus; acked: boolean }
export type Open = { kind: AlertKind; key: string }

const statusOfRun = (run: readonly AlertRecord[]): PinStatus => {
  if (wasSent(run)) return 'sent'
  const last = run.at(-1)

  return last === undefined || last.outcome === 'failed' || last.outcome === 'refused' ? 'not-sent' : last.outcome === 'deferred' ? 'deferred' : last.outcome === 'silenced' ? (last.why === 'kind-off' ? 'kind-off' : 'silenced') : 'held'
}

/**
 * Every raised condition that still holds, gravest first. `open` is what holds now; a condition is raised once the
 * engine recorded anything for its current occurrence, so one that is only told at a stop is not listed before it.
 * Acknowledged means its latest record is: a notice written after an acknowledgment is news again.
 */
export const conditionsOf = (kept: readonly AlertRecord[], open: readonly Open[]): Pin[] =>
  [...open].sort((a, b) => byPriority(a.kind, b.kind)).flatMap(o => {
    const run = episodeOf(kept, o.key)
    const last = run.at(-1)

    return last === undefined ? [] : [{ key: o.key, kind: o.kind, taskId: last.taskId, level: LEVEL[o.kind], status: statusOfRun(run), acked: last.acked === true }]
  })
/** The HUD's pins: the raised conditions that still hold and were not acknowledged. Resolved or acknowledged, a pin is gone. */
export const pinsOf = (kept: readonly AlertRecord[], open: readonly Open[]): Pin[] => conditionsOf(kept, open).filter(p => !p.acked)

const PIN_NAME: Record<AlertKind, string> = { 'security-failure': 'security check failed', 'release-no-go': 'release NO-GO', 'verification-exhausted': 'verification exhausted', 'review-hold': 'review hold open', 'run-blocked': 'run blocked' }
/** What became of the notification. SENT is the host having written it; nothing here says it was seen. */
const PIN_STATUS: Record<PinStatus, string> = { sent: 'notification SENT, not acknowledged', 'not-sent': 'notification NOT SENT', deferred: 'DEFERRED, quiet hours', held: 'HELD BACK, cooldown or budget', 'kind-off': 'NOT NOTIFIED, kind off', silenced: 'NOT NOTIFIED, silenced' }
const PIN_SHORT: Record<PinStatus, string> = { sent: 'SENT', 'not-sent': 'NOT SENT', deferred: 'DEFERRED', held: 'HELD', 'kind-off': 'OFF', silenced: 'SILENCED' }

export type PinLine = { text: string; level: Level | 'INFO' }
/**
 * The one HUD row of the alerts, or null when there is nothing to pin: no open condition and a confirmed transport
 * (or alerts off). It is the widest of its forms that fits `width`, so a narrow band keeps the level and the count.
 * `unconfirmed`: alerts are armed and nobody confirmed a notification in this session. Static: it never animates.
 */
export const pinLine = (pins: readonly Pin[], unconfirmed: boolean, label: string, width: number): PinLine | null => {
  const first = pins[0]
  const fit = (forms: readonly string[]): string => forms.find(f => f.length <= width) ?? (forms.at(-1) ?? '').slice(0, Math.max(0, width))
  if (first === undefined) {
    if (!unconfirmed) return null

    return { text: fit([`GUARD: ${label} · transport not confirmed · /cockpit guard test`, `GUARD: ${label} · transport not confirmed`, `GUARD: ${label} · unconfirmed`, `GUARD: ${label}`]), level: 'INFO' }
  }
  const more = pins.length > 1 ? ` · +${pins.length - 1} more` : ''
  const link = unconfirmed ? ' · transport not confirmed' : ''
  const head = `GUARD ▲ ${first.level} ${PIN_NAME[first.kind]}`

  return {
    text: fit([
      `${head} · task ${first.taskId} · ${PIN_STATUS[first.status]}${more}${link} · /cockpit guard`,
      `${head} · task ${first.taskId} · ${PIN_STATUS[first.status]}${more}${link}`,
      `${head} · ${PIN_SHORT[first.status]}${more}${link}`,
      `${head} · ${PIN_SHORT[first.status]}${more}`,
      `${head}${more}`,
      `▲ ${first.level}${pins.length > 1 ? ` +${pins.length - 1}` : ''}`,
      `▲ ${first.level}`,
      '▲',
    ]),
    level: first.level,
  }
}

/** What the status needs beyond the records: the moment, what holds now, the channel last written to, and the connection. */
export type GuardView = { now: number; open: readonly Open[]; channel: string | null; isSsh: boolean }

/** The priority, kind and quiet-hours status and the active conditions, for `/cockpit guard` and `/cockpit doctor`. */
export const policyLines = (cfg: GuardConfig, kept: readonly AlertRecord[], view: GuardView): string[] => {
  if (!cfg.enabled) return []
  const off = KINDS.filter(k => !cfg.kinds.includes(k))
  const lines = [
    `Priority: ${(['CRITICAL', 'HIGH', 'NORMAL'] as const).map(l => `${l} ${PRIORITY.filter(k => LEVEL[k] === l).join(', ')}`).join(' · ')}. Fixed; it orders the HUD and sets what quiet hours treat as critical.`,
    off.length === 0 ? 'Notified kinds: all five (guardNotifyKinds).' : `Notified kinds: ${[...cfg.kinds].sort(byPriority).join(', ')} · NOT notified: ${[...off].sort(byPriority).join(', ')} (still recorded and shown on the HUD and here; a critical kind cannot be turned off).`,
    ...cfg.kindProblems.map(p => `  WARN ${p}`),
    ...quietLines(cfg.quiet, view.now, view.channel, view.isSsh),
  ]
  const active = conditionsOf(kept, view.open)
  if (active.length === 0) lines.push('Active conditions: none raised and still open.')
  for (const p of active) lines.push(`  ACTIVE ${p.level} ${p.kind} · task ${p.taskId} · ${p.status === 'sent' ? 'notification SENT' : PIN_STATUS[p.status]} · ${p.acked ? 'acknowledged' : 'not acknowledged'}`)
  const owed = deferredOf(kept).filter(d => view.open.some(o => o.key === d.key)).length
  if (owed > 0) lines.push(`  ${owed} deferred alert${owed === 1 ? ' is' : 's are'} owed a notification: ${isQuiet(cfg.quiet, view.now) ? 'after quiet hours end' : 'at the next look, inside the cooldown and the budget'}, ${owed === 1 ? 'if still open then' : 'as one notification, for those still open then'}.`)

  return lines
}

export const guardText = (cfg: GuardConfig, state: GuardState, kept: readonly AlertRecord[], view?: GuardView): string => {
  const lines = [`GUARD: ${labelOf(cfg, state, kept)}`]
  if (!cfg.enabled) lines.push('Off. Set guardAlerts to true to be told when a run needs you. No alert is sent while off.')
  else {
    lines.push(`Armed · ${state.count} of ${cfg.maxPerSession} alerts used this session · at most one every ${Math.round(cfg.cooldownMs / 1000)}s · same condition never twice.`)
    lines.push('Delivery: your terminal notification channel, through the host. SENT means the host wrote it to your terminal; it cannot confirm that you saw it. No webhook, email or push exists in this version.')
  }
  if (cfg.enabled && state.all) lines.push('Silenced for this session: nothing is sent or repeated. /cockpit guard unsilence resumes.')
  if (cfg.enabled) {
    lines.push(cfg.repeat
      ? `Persistent: on · a condition still open is repeated every ${Math.round(cfg.repeatMs / 1000)}s, at most ${cfg.maxReminders} times each, inside the same budget and cooldown. /cockpit guard ack stops the repeats.`
      : 'Persistent: off · each condition is told once. Set guardRepeat to true to be reminded while it stays open.')
    lines.push(`Sound: ${cfg.sound ? 'on · the checkpoint cue (or the terminal bell) is tried with each alert, unless sounds are off or muted. ATTEMPTED means a player exited 0, not that it was heard.' : 'off'}`)
    if (view !== undefined) lines.push(...policyLines(cfg, kept, view))
  }
  if (cfg.repeat) {
    for (const a of noticedOf(kept)) {
      const run = episodeOf(kept, a.key)
      const made = run.filter(r => r.nth !== undefined).length
      const state1 = run.some(r => r.acked === true) ? 'acknowledged, no more reminders' : state.all || state.silenced.includes(a.key) ? 'silenced' : made >= cfg.maxReminders ? 'reminders spent' : state.count >= cfg.maxPerSession - 1 ? 'session budget spent' : 'reminding'
      lines.push(`  OPEN ${a.kind} · task ${a.taskId} · reminders ${made} of ${cfg.maxReminders} · ${state1}`)
    }
  }
  for (const a of kept.slice(-5)) lines.push(`  ${a.kind} · task ${a.taskId} · ${a.outcome}${a.nth === undefined ? '' : ` (reminder ${a.nth})`}${a.channel === null ? (a.why === undefined ? '' : ` (${a.why})`) : ` via ${a.channel}`}${a.cue === undefined ? '' : ` · ${a.cue} attempted`}${a.acked === true ? ' · acknowledged' : ''}`)
  lines.push('An alert never clears a review hold, approves a release or changes a verdict. /cockpit guard ack acknowledges; /cockpit guard silence mutes this session.')

  return lines.join('\n')
}

const OUTCOME_SET: readonly string[] = ['sent', 'failed', 'refused', 'throttled', 'silenced', 'resolved', 'deferred']
const WHY_SET: readonly string[] = ['disabled', 'no-channel', 'no-surface', 'refused', 'error', 'cooldown', 'budget', 'quiet', 'kind-off']
/** Whether a stored alert has exactly the shape this build writes. A malformed one is dropped, never believed. */
export const isAlertRecord = (x: unknown): x is AlertRecord => {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>

  return typeof r['key'] === 'string' && r['key'].length <= 120 && KINDS.includes(r['kind'] as AlertKind) && Number.isSafeInteger(r['taskId']) && typeof r['at'] === 'number'
    && OUTCOME_SET.includes(r['outcome'] as string) && Number.isSafeInteger(r['attempts']) && (r['channel'] === null || (typeof r['channel'] === 'string' && r['channel'].length <= 32))
    && (r['why'] === undefined || WHY_SET.includes(r['why'] as string)) && (r['acked'] === undefined || r['acked'] === true)
    && (r['nth'] === undefined || (Number.isSafeInteger(r['nth']) && (r['nth'] as number) >= 1 && (r['nth'] as number) <= REMINDERS_CEILING))
    && (r['cue'] === undefined || r['cue'] === 'sound' || r['cue'] === 'bell')
}
export const validAlerts = (x: unknown): AlertRecord[] => (Array.isArray(x) ? x.filter(isAlertRecord).slice(-ALERT_CAP) : [])
