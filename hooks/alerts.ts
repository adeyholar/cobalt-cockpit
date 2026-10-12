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
//
// The alert inbox (v0.5.7) reads the same kept records as occurrences: each record carries the id of its occurrence, one
// occurrence can be acknowledged on its own, and the HUD counts what was recorded and never acknowledged. It is a view of
// the records, not a second store, and it reports what was recorded, never that anyone saw it.

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
  /** `guardDigest` (v0.5.8): one line about unacknowledged recorded alerts, once, at the start of a session. Independent of `guardAlerts`. */
  digest: boolean
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
  digest: options['guardDigest'] === true,
})

/** One alert as the Run Ledger keeps it: closed vocabulary and numbers only. */
export type AlertRecord = { key: string; kind: AlertKind; taskId: number; at: number; outcome: AlertOutcome; attempts: number; channel: string | null; why?: Why; acked?: true; /** Which reminder of its condition this is; absent on the first alert. */ nth?: number; /** The audible cue a player exited 0 for: ATTEMPTED, never heard. */ cue?: Cue; /** v0.5.7: which occurrence of its condition this record belongs to (8 hex, from the key and the first moment; no content). Absent on older records, where it is derived the same way. */ id?: string }
export type Cue = 'sound' | 'bell'
export type Why = 'disabled' | 'no-channel' | 'no-surface' | 'refused' | 'error' | 'cooldown' | 'budget' | 'quiet' | 'kind-off'
export const RETRY_CAP = 3

export type GuardState = {
  sentAt: number | null; count: number; silenced: string[]; all: boolean; pending: boolean
  /** v0.5.7: counts the person's acknowledgments. A pass notes it when it begins deciding; a notice written after one is born acknowledged. A count, not a time, so a clock stepped back changes nothing. */
  seq?: number
  /** The count at the last acknowledgment of everything. */
  ackSeq?: number
  /** The latest few single acknowledgments: the condition's key and the count it was made at. */
  ackedKeys?: { key: string; seq: number }[]
}
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

/** A deferred condition the person acknowledged before anything was sent: they know, so it is not announced afterwards. (One held back by the cooldown or budget is still told: `guard ack` must not silence a critical condition nobody was told of.) */
export const isSettledQuietly = (kept: readonly AlertRecord[], key: string): boolean => {
  const run = episodeOf(kept, key)

  return run.length > 0 && !wasSent(run) && run.at(-1)?.acked === true && wasDeferred(run)
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

/** Whether the person acknowledged this condition (or everything) after `since`, the count a pass noted when it began deciding: a notice still being written is then acknowledged too. */
export const isAckedSince = (state: GuardState, key: string, since: number): boolean =>
  (typeof state.ackSeq === 'number' && state.ackSeq > since) || (Array.isArray(state.ackedKeys) && state.ackedKeys.some(k => k !== null && typeof k === 'object' && k.key === key && typeof k.seq === 'number' && k.seq > since))
export const ACKED_KEYS = 8
/** The state after the person acknowledged everything (`key` null) or one condition. */
export const withAck = (state: GuardState, key: string | null): GuardState => {
  const seq = (state.seq ?? 0) + 1

  return key === null ? { ...state, seq, ackSeq: seq } : { ...state, seq, ackedKeys: [...(state.ackedKeys ?? []), { key, seq }].slice(-ACKED_KEYS) }
}

/**
 * Bounded, and when full it gives up the oldest held-back or silenced record first, so a written one is not pushed out by them.
 * Next go the records of an occurrence already resolved, oldest first and the `resolved` mark after what it closes, so an
 * open condition's alert, its reminder count and its acknowledgment are the last things forgotten. Every record is stamped
 * with the id of its occurrence as it is added.
 */
export const bounded = (kept: readonly AlertRecord[], add: AlertRecord): AlertRecord[] => {
  const all = [...kept, add.id === undefined || !ID_RE.test(add.id) ? { ...add, id: nextIdOf(kept, add) } : add]
  while (all.length > ALERT_CAP) {
    // a held-back or silenced record goes first, unless it is the only record its condition has: that one keeps it on the HUD
    let drop = all.findIndex((a, i) => (a.outcome === 'throttled' || a.outcome === 'silenced') && all.some((b, j) => j !== i && b.key === a.key))
    if (drop < 0 || drop >= all.length - 1) drop = all.findIndex((a, i) => a.outcome !== 'resolved' && all.some((b, j) => j > i && b.key === a.key && b.outcome === 'resolved'))
    if (drop < 0) drop = all.findIndex((a, i) => i < all.length - 1 && a.outcome === 'resolved')
    all.splice(drop >= 0 && drop < all.length - 1 ? drop : 0, 1)
  }

  return all
}

// --- The alert inbox (v0.5.7): the kept records read as occurrences. Nothing here is a second store. ---

export const ID_RE = /^[0-9a-f]{8}$/
/** A 32-bit FNV-1a over the key and the moment, as 8 hex digits: an identifier, not a secret, and it carries nothing of its input. */
const hashOf = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0

  return h.toString(16).padStart(8, '0')
}
const freshId = (key: string, at: number, taken: ReadonlySet<string>): string => {
  for (let salt = 0; ; salt++) {
    const id = hashOf(`${key}\0${at}\0${salt}`)
    if (!taken.has(id)) return id
  }
}

/** One occurrence of a condition: its records from the first one kept to the `resolved` mark that closed it, or to the latest. */
export type Episode = { id: string; key: string; records: AlertRecord[]; closed: boolean }

/**
 * The occurrences in the kept records, oldest first. A record stamped with an id keeps it whatever is evicted around it;
 * one without (written before v0.5.7) gets the id it would have been stamped with, and an id two occurrences claim
 * belongs to the older one. A run of nothing but `resolved` marks (what was resolved has been evicted) is not an occurrence.
 */
export const episodesOf = (kept: readonly AlertRecord[]): Episode[] => {
  const live = new Map<string, Episode>()
  const out: Episode[] = []
  for (const a of kept) {
    let e = live.get(a.key)
    if (e === undefined) { e = { id: '', key: a.key, records: [], closed: false }; live.set(a.key, e); out.push(e) }
    e.records.push(a)
    if (a.outcome === 'resolved') { e.closed = true; live.delete(a.key) }
  }
  const real = out.filter(e => e.records.some(a => a.outcome !== 'resolved'))
  const taken = new Set<string>()
  for (const e of real) {
    const stamped = e.records.find(a => a.id !== undefined && ID_RE.test(a.id))?.id
    if (stamped !== undefined && !taken.has(stamped)) { e.id = stamped; taken.add(stamped) }
  }
  for (const e of real) if (e.id === '') { e.id = freshId(e.key, (e.records[0] as AlertRecord).at, taken); taken.add(e.id) }

  return real
}

/** The id a record about to be added carries: that of its condition's open occurrence, or a new one. */
const nextIdOf = (kept: readonly AlertRecord[], add: AlertRecord): string => {
  const eps = episodesOf(kept)
  const open = eps.filter(e => e.key === add.key && !e.closed).at(-1)

  return open !== undefined ? open.id : freshId(add.key, add.at, new Set(eps.map(e => e.id)))
}

export type Occurrence = {
  id: string; key: string; kind: AlertKind; level: Level; taskId: number
  /** When its first record was written, and its latest. Clock readings of this machine, as recorded. */
  at: number; lastAt: number
  status: PinStatus; channel: string | null; reminders: number; acked: boolean
  /** open: the condition holds now; resolved: it was recorded resolved; ended: no longer holding, with no resolution recorded yet (a task replaced or gone). */
  state: 'open' | 'resolved' | 'ended'
  /** Where its latest record sits among the kept ones: the order they were written in, whatever their clock readings. */
  seq: number
}

/** Every occurrence in the kept records, with what holds now (`open`). Not ordered; see `inboxOrder`. */
export const occurrencesOf = (kept: readonly AlertRecord[], open: readonly Open[]): Occurrence[] =>
  episodesOf(kept).flatMap(e => {
    const run = e.records.filter(a => a.outcome !== 'resolved')
    const last = run.at(-1) as AlertRecord
    const sent = run.filter(a => a.outcome === 'sent' && a.channel !== null).at(-1)

    return [{
      id: e.id, key: e.key, kind: last.kind, level: LEVEL[last.kind], taskId: last.taskId,
      at: (run[0] as AlertRecord).at, lastAt: last.at,
      status: statusOfRun(run), channel: sent?.channel ?? null, reminders: run.filter(a => a.nth !== undefined).length, acked: last.acked === true,
      state: e.closed ? 'resolved' as const : open.some(o => o.key === e.key) ? 'open' as const : 'ended' as const,
      seq: kept.lastIndexOf(last),
    }]
  })

/** Open and not acknowledged first (gravest, then newest), then open and acknowledged, then what no longer holds (newest first). */
export const inboxOrder = (occ: readonly Occurrence[]): Occurrence[] => {
  const rank = (o: Occurrence): number => (o.state === 'open' ? (o.acked ? 1 : 0) : 2)

  return [...occ].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? 0 : byPriority(a.kind, b.kind)) || b.seq - a.seq)
}
/** What the HUD counts beyond its pins: recorded occurrences that no longer hold and were never acknowledged. */
export const unreadOf = (occ: readonly Occurrence[]): number => occ.filter(o => o.state !== 'open' && !o.acked).length

export type AckResult = { alerts: AlertRecord[]; result: 'acked' | 'already' | 'unknown' | 'malformed'; occurrence?: Occurrence }
/**
 * Acknowledges exactly one occurrence: every record of it, and no other. Pure. An id that is not 8 lowercase hex digits is
 * `malformed`; one that no kept occurrence has (never existed, or evicted) is `unknown`. A resolved or ended occurrence can
 * be acknowledged too, and that changes nothing but its record.
 */
export const ackOccurrence = (kept: readonly AlertRecord[], open: readonly Open[], id: string): AckResult => {
  if (!ID_RE.test(id)) return { alerts: [...kept], result: 'malformed' }
  const mine = episodesOf(kept).filter(e => e.id === id)[0]
  if (mine === undefined) return { alerts: [...kept], result: 'unknown' }
  const occurrence = occurrencesOf(kept, open).find(o => o.id === id)
  const pending = mine.records.filter(a => a.acked !== true && a.outcome !== 'resolved')
  if (pending.length === 0) return { alerts: [...kept], result: 'already', ...(occurrence === undefined ? {} : { occurrence }) }

  return { alerts: kept.map(a => (pending.includes(a) ? { ...a, acked: true as const } : a)), result: 'acked', ...(occurrence === undefined ? {} : { occurrence: { ...occurrence, acked: true } }) }
}

// --- v0.5.8: acknowledgments as keys of their own, the history merge, and the return digest ---

export const ACK_PREFIX = 'alert-ack:'
export const HISTORY_PREFIX = 'alert-history:'
export const PROJECT_RE = /^[0-9a-f]{12}$/
/** At most this many acknowledgment keys are kept in all: four projects of 32 occurrences each. */
export const ACK_KEYS_MAX = 128
export const HISTORY_PROJECTS_MAX = 4

/** The store key of one acknowledged occurrence. The host sets a key in one step, so writing it is one atomic act that no other write can undo. */
export const ackKeyOf = (project: string, id: string): string => `${ACK_PREFIX}${project}:${id}`
const parseAckKey = (key: unknown): { project: string; id: string } | null => {
  if (typeof key !== 'string' || !key.startsWith(ACK_PREFIX)) return null
  const [project, id, ...rest] = key.slice(ACK_PREFIX.length).split(':')

  return rest.length === 0 && project !== undefined && id !== undefined && PROJECT_RE.test(project) && ID_RE.test(id) ? { project, id } : null
}
export const historyKeyOf = (project: string): string => `${HISTORY_PREFIX}${project}`
export const isHistoryKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith(HISTORY_PREFIX) && PROJECT_RE.test(key.slice(HISTORY_PREFIX.length))
/** The occurrences of this project acknowledged in the store, from the keys it lists. A key that is not exactly ours is ignored. */
export const ackedIdsOf = (keys: readonly unknown[], project: string): Set<string> => new Set(keys.flatMap(k => { const a = parseAckKey(k); return a !== null && a.project === project ? [a.id] : [] }))
/** The acknowledgment keys to forget so that at most `max` remain: the oldest, as the store lists them. */
export const excessAckKeys = (keys: readonly unknown[], max: number = ACK_KEYS_MAX): string[] => {
  const mine = keys.filter((k): k is string => parseAckKey(k) !== null)

  return mine.slice(0, Math.max(0, mine.length - max))
}
/** The history keys to forget so that at most `max` projects remain, never `keep`: the oldest, as the store lists them. */
export const excessHistoryKeys = (keys: readonly unknown[], keep: string, max: number = HISTORY_PROJECTS_MAX): string[] => {
  const mine = keys.filter(isHistoryKey)

  return mine.filter(k => k !== keep).slice(0, Math.max(0, mine.length - max))
}
/** The occurrences with a record not yet acknowledged, resolved ones apart: what `guard ack` acknowledges. */
export const pendingIdsOf = (kept: readonly AlertRecord[]): string[] =>
  episodesOf(kept).filter(e => e.records.some(a => a.outcome !== 'resolved' && a.acked !== true)).map(e => e.id)
/** The ids of the occurrences some record already marks acknowledged: what a history written before v0.5.8 knows. */
export const markedIdsOf = (kept: readonly AlertRecord[]): string[] =>
  episodesOf(kept).filter(e => e.records.some(a => a.outcome !== 'resolved' && a.acked === true)).map(e => e.id)
/** Marks every record of the occurrences in `ids` acknowledged. Pure; the same array when nothing changes. */
export const applyAcks = (kept: readonly AlertRecord[], ids: ReadonlySet<string>): AlertRecord[] => {
  if (ids.size === 0) return kept as AlertRecord[]
  const pending = new Set(episodesOf(kept).filter(e => ids.has(e.id)).flatMap(e => e.records.filter(a => a.acked !== true && a.outcome !== 'resolved')))
  if (pending.size === 0) return kept as AlertRecord[]

  return kept.map(a => (pending.has(a) ? { ...a, acked: true as const } : a))
}
/**
 * What a session writes as its project's history: the occurrences the stored history has and this session never saw,
 * then this session's own records, capped. An occurrence both hold is this session's copy (its records are the live ones);
 * what they differ in is not decided by guessing. An acknowledgment is never lost to the merge: the ids acknowledged in
 * the store, or marked acknowledged in either copy, are applied to the result. Pure.
 */
export const mergeHistory = (own: readonly AlertRecord[], stored: readonly AlertRecord[], acked: ReadonlySet<string> = new Set()): AlertRecord[] => {
  const mine = new Set(episodesOf(own).map(e => e.id))
  const ownKeys = new Set(own.map(a => a.key))
  // an occurrence of a condition this session also holds records of is not added from the stored copy: grouped with the session's
  // own, the two would become one run and the later occurrence would lose its id
  const foreign = episodesOf(stored).filter(e => !mine.has(e.id) && !ownKeys.has(e.key)).flatMap(e => e.records)
  const all = new Set([...acked, ...markedIdsOf(own), ...markedIdsOf(stored)])

  return applyAcks([...foreign, ...own], all).slice(-ALERT_CAP)
}

export type Digest = {
  recorded: number; unacked: number
  levels: Record<Level, number>
  open: number; history: number
  deferred: number; notSent: number; held: number
  oldest: Occurrence | null
}
/** The unacknowledged occurrences counted: by level, open or historical, by what became of the notification, and the oldest. Deterministic, from the records. */
export const digestOf2 = (occ: readonly Occurrence[]): Digest => {
  const un = occ.filter(o => !o.acked)
  const oldest = [...un].sort((a, b) => a.at - b.at || a.seq - b.seq)[0] ?? null

  return {
    recorded: occ.length, unacked: un.length,
    levels: { CRITICAL: un.filter(o => o.level === 'CRITICAL').length, HIGH: un.filter(o => o.level === 'HIGH').length, NORMAL: un.filter(o => o.level === 'NORMAL').length },
    open: un.filter(o => o.state === 'open').length, history: un.filter(o => o.state !== 'open').length,
    deferred: un.filter(o => o.status === 'deferred').length, notSent: un.filter(o => o.status === 'not-sent').length, held: un.filter(o => o.status === 'held').length,
    oldest,
  }
}
/** `/cockpit alerts digest`. Counts only: no id, key, path or text from a record beyond its moment. Says what was recorded, never what anyone saw. */
export const digestText = (occ: readonly Occurrence[], now: number, enabled: boolean): string => {
  const d = digestOf2(occ)
  const lines: string[] = []
  if (d.recorded === 0) lines.push('ALERT DIGEST · nothing recorded.')
  else if (d.unacked === 0) lines.push(`ALERT DIGEST · nothing unacknowledged of ${d.recorded} recorded.`)
  else {
    lines.push(`ALERT DIGEST · ${d.unacked} unacknowledged of ${d.recorded} recorded`)
    lines.push(`By level: CRITICAL ${d.levels.CRITICAL} · HIGH ${d.levels.HIGH} · NORMAL ${d.levels.NORMAL}`)
    lines.push(`Condition open now: ${d.open} · no longer open (history): ${d.history}`)
    const notes = [d.deferred > 0 ? `${d.deferred} DEFERRED, quiet hours` : '', d.notSent > 0 ? `${d.notSent} NOT SENT` : '', d.held > 0 ? `${d.held} HELD BACK, cooldown or budget` : ''].filter(n => n !== '')
    if (notes.length > 0) lines.push(`Notifications: ${notes.join(' · ')}`)
    if (d.oldest !== null) lines.push(`Oldest unacknowledged: recorded ${stamp(d.oldest.at)}${ageOf(now - d.oldest.at)}`)
    lines.push('These are records of what Cockpit wrote and what the host reported; they say nothing about what anyone saw.')
  }
  if (!enabled) lines.push('Alerts are off (guardAlerts): this is what was recorded earlier; nothing new is recorded or sent.')
  lines.push('Details: /cockpit alerts · acknowledge one: /cockpit alerts ack <id>')

  return lines.join('\n')
}
/** The one line shown once at the start of a session when `guardDigest` is on; null when there is nothing unacknowledged. */
export const digestToast = (occ: readonly Occurrence[]): string | null => {
  const d = digestOf2(occ)
  if (d.unacked === 0) return null
  const lv = (['CRITICAL', 'HIGH', 'NORMAL'] as const).filter(l => d.levels[l] > 0).map(l => `${d.levels[l]} ${l}`).join(', ')

  return `Cobalt alerts: ${d.unacked} unacknowledged recorded (${lv}) · /cockpit alerts digest`
}

const stamp = (at: number): string => {
  try { return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z` } catch { return 'time unknown' }
}
const ageOf = (ms: number): string => (ms < 0 ? '' : ms < 60_000 ? ' (just now)' : ms < 3_600_000 ? ` (${Math.floor(ms / 60_000)}m ago)` : ms < 172_800_000 ? ` (${Math.floor(ms / 3_600_000)}h ago)` : ` (${Math.floor(ms / 86_400_000)}d ago)`)
const OUTCOME: Record<PinStatus, string> = { sent: 'notification SENT', 'not-sent': 'notification NOT SENT', deferred: 'DEFERRED, quiet hours', held: 'HELD BACK, cooldown or budget', 'kind-off': 'NOT NOTIFIED, kind off', silenced: 'NOT NOTIFIED, silenced' }
const STATE: Record<Occurrence['state'], string> = { open: 'condition OPEN now', resolved: 'condition no longer open (recorded resolved)', ended: 'condition no longer open (task replaced or gone)' }
export const INBOX_PAGE = 8

export const inboxPages = (n: number): number => Math.max(1, Math.ceil(n / INBOX_PAGE))
/**
 * The inbox, one page of it. Each line is one occurrence: its id, level, kind, task, the moment it was recorded, what became
 * of its notification, whether it was acknowledged, and whether the condition holds now. "Recorded" is when Cockpit wrote the
 * record; "open now" is read off the task as it is now; SENT is the host saying it wrote the notification. None of it says
 * a person saw anything, and no connection is claimed to have dropped or returned.
 */
export const inboxText = (occ: readonly Occurrence[], page: number, now: number, enabled: boolean): string => {
  const ordered = inboxOrder(occ)
  const pages = inboxPages(ordered.length)
  const at = Math.min(Math.max(1, page), pages)
  const lines = [`ALERT INBOX · ${ordered.length} recorded · ${ordered.filter(o => o.state === 'open').length} open now · ${ordered.filter(o => !o.acked).length} unacknowledged · page ${at} of ${pages}`]
  if (!enabled) lines.push('Alerts are off (guardAlerts): what was recorded earlier is shown; nothing new is recorded or sent.')
  if (ordered.length === 0) lines.push('Nothing recorded. An alert is recorded when a run needs a person: a failed security check, a NO-GO, exhausted verification, an open review or a blocked run.')
  let group = ''
  for (const o of ordered.slice((at - 1) * INBOX_PAGE, at * INBOX_PAGE)) {
    const g = o.state === 'open' ? 'OPEN NOW (read from the current task)' : 'HISTORY (recorded earlier; the condition no longer holds)'
    if (g !== group) { lines.push(g); group = g }
    lines.push(`  ${o.id} ${o.level} ${o.kind} · task ${o.taskId} · recorded ${stamp(o.at)}${ageOf(now - o.at)} · ${OUTCOME[o.status]}${o.status === 'sent' && o.channel !== null ? ` via ${o.channel}` : ''}${o.reminders > 0 ? ` · ${o.reminders} reminder${o.reminders === 1 ? '' : 's'}` : ''} · ${o.acked ? 'acknowledged' : 'not acknowledged'} · ${STATE[o.state]}`)
  }
  if (pages > 1) lines.push(`More: /cockpit alerts ${at < pages ? at + 1 : 1}`)
  lines.push('/cockpit alerts ack <id> acknowledges that one occurrence and stops its reminders; /cockpit guard ack acknowledges all. Neither changes a gate, a review, an approval or a verdict.')

  return lines.join('\n')
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
export const pinLine = (pins: readonly Pin[], unconfirmed: boolean, label: string, width: number, unread = 0): PinLine | null => {
  const first = pins[0]
  const fit = (forms: readonly string[]): string => forms.find(f => f.length <= width) ?? (forms.at(-1) ?? '').slice(0, Math.max(0, width))
  if (first === undefined) {
    if (!unconfirmed && unread === 0) return null
    if (unread === 0) return { text: fit([`GUARD: ${label} · transport not confirmed · /cockpit guard test`, `GUARD: ${label} · transport not confirmed`, `GUARD: ${label} · unconfirmed`, `GUARD: ${label}`]), level: 'INFO' }
    // recorded alerts nobody acknowledged and that no longer hold: a count and where to read them, never an inference about a person
    const seen = ` · ${unread} unacknowledged in history`
    const link = unconfirmed ? ' · transport not confirmed' : ''

    return { text: fit([`GUARD: ${label}${seen}${link} · /cockpit alerts`, `GUARD: ${label}${seen}${link}`, `GUARD: ${label}${seen}`, `GUARD: ${label} · ${unread} unacknowledged`, `GUARD: ${label} · ${unread} unack`, `GUARD: ${label}`]), level: 'INFO' }
  }
  const more = pins.length > 1 ? ` · +${pins.length - 1} more` : ''
  const link = unconfirmed ? ' · transport not confirmed' : ''
  const head = `GUARD ▲ ${first.level} ${PIN_NAME[first.kind]}`

  return {
    text: fit([
      `${head} · task ${first.taskId} · ${PIN_STATUS[first.status]}${more}${link} · /cockpit alerts`,
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
    lines.push(`Armed · ${state.count} of ${cfg.maxPerSession} alerts used this session · at most one every ${Math.round(cfg.cooldownMs / 1000)}s · the same occurrence never twice.`)
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

  return typeof r['key'] === 'string' && r['key'].length <= 120 && KINDS.includes(r['kind'] as AlertKind) && Number.isSafeInteger(r['taskId']) && typeof r['at'] === 'number' && Number.isFinite(r['at'])
    && OUTCOME_SET.includes(r['outcome'] as string) && Number.isSafeInteger(r['attempts']) && (r['channel'] === null || (typeof r['channel'] === 'string' && r['channel'].length <= 32))
    && (r['why'] === undefined || WHY_SET.includes(r['why'] as string)) && (r['acked'] === undefined || r['acked'] === true)
    && (r['nth'] === undefined || (Number.isSafeInteger(r['nth']) && (r['nth'] as number) >= 1 && (r['nth'] as number) <= REMINDERS_CEILING))
    && (r['cue'] === undefined || r['cue'] === 'sound' || r['cue'] === 'bell')
    && (r['id'] === undefined || (typeof r['id'] === 'string' && ID_RE.test(r['id'])))
}
export const validAlerts = (x: unknown): AlertRecord[] => (Array.isArray(x) ? x.filter(isAlertRecord).slice(-ALERT_CAP) : [])
