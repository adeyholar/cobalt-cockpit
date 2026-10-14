// Cobalt Guard Calibration (v0.6.3): what a person says, looking back, they would have wanted for a recorded incident, and how
// the alert policy as it is configured would have done against those answers.
//
// It is an evaluation and controls nothing. A label is an answer to a question: it acknowledges nothing, resolves nothing,
// sends nothing, and changes no setting, gate, hold or release. The policy is simulated by the live policy's own decision
// functions (`decide` and `holdOf` in alerts.ts) on a frozen copy of the configuration with notifications on. The
// configuration itself is never written, and nothing here can notify: this module is given no engine handle at all.
//
// What a session's state decided at the time (the cooldown since its last alert, its alert budget, a silence, a send that
// failed and its retries, reminders) is not kept with an occurrence and is not simulated. Each occurrence is judged on its
// own, at the moment it was first recorded. The report names what was left out, next to the figures.
//
// Every figure is about incidents Cockpit recorded and a person reviewed. An event that was never recorded is in none of
// them, so nothing here measures detection, and no figure is given that name.
//
// A label is one plugin-store key of its own, `alert-label:<project>:<id>`, holding the label and the moment it was set and
// nothing else. It is written whole with one `set` and removed with one `delete`, like an acknowledgment, so two sessions
// labelling different occurrences cannot lose each other's and the later of two labels on one occurrence stands. Nothing
// derived is stored: the simulation and the report are computed when asked for.

import { EMPTY_GUARD, ID_RE, INBOX_PAGE, KINDS, LEVEL, OCC_PREFIX, PRIORITY, PROJECT_RE, ageOf, applyAcks, byPriority, decide, episodesOf, guardConfigOf, holdOf, isCritical, occKeyOf, occurrencesOf, stamp, standingOf, validAlerts } from './alerts'
import type { AlertKind, AlertRecord, GuardConfig, Level, Observation, Occurrence, Open, Standing } from './alerts'
import { clockOf, machineZone } from './quiet'

// --- The label: a closed vocabulary of three, and the key that holds one ---

export type Label = 'NOTIFY' | 'RECORD_ONLY' | 'NOISE'
export const LABELS: readonly Label[] = ['NOTIFY', 'RECORD_ONLY', 'NOISE']
/** What each label says, in the person's own terms. Closed sentences. */
export const LABEL_MEANING: Readonly<Record<Label, string>> = { NOTIFY: 'you would have wanted a notification', RECORD_ONLY: 'worth recording, not worth interrupting you', NOISE: 'not useful as an incident' }
/** The word a person types for a label, `clear` to remove one, or null for anything else. Compared whole: no word is looked up in an object. */
export const labelOfWord = (word: unknown): Label | 'clear' | null => (word === 'notify' ? 'NOTIFY' : word === 'record' ? 'RECORD_ONLY' : word === 'noise' ? 'NOISE' : word === 'clear' ? 'clear' : null)

export const LABEL_PREFIX = 'alert-label:'
/** The store key of one occurrence's label. The host sets a key in one step, so writing it is one atomic act that no write of another key can undo. */
export const labelKeyOf = (project: string, id: string): string => `${LABEL_PREFIX}${project}:${id}`
export const parseLabelKey = (key: unknown): { project: string; id: string } | null => {
  if (typeof key !== 'string' || !key.startsWith(LABEL_PREFIX)) return null
  const [project, id, ...rest] = key.slice(LABEL_PREFIX.length).split(':')

  return rest.length === 0 && project !== undefined && id !== undefined && PROJECT_RE.test(project) && ID_RE.test(id) ? { project, id } : null
}
/** The occurrences of this project the store holds a label key for, from the keys it lists. A key that is not exactly ours is ignored. */
export const labelledIdsOf = (keys: readonly unknown[], project: string): Set<string> => new Set(keys.flatMap(k => { const l = parseLabelKey(k); return l !== null && l.project === project ? [l.id] : [] }))

/** All a label key holds: the label and the clock reading when it was set. No path, prompt, command or free text has a field to be in. */
export type StoredLabel = { v: 1; label: Label; at: number }
export const labelValueOf = (label: Label, at: number): StoredLabel => ({ v: 1, label, at })
/** The label a stored value holds, or null when it is not exactly what this build writes: the occurrence is then unreviewed, never guessed. */
export const labelOfValue = (value: unknown): Label | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>

  return Object.keys(v).length === 3 && v['v'] === 1 && LABELS.includes(v['label'] as Label) && typeof v['at'] === 'number' && Number.isFinite(v['at']) ? v['label'] as Label : null
}

/**
 * The label keys whose occurrence is gone: no occurrence key of the same project and id among `keys`, and not `isKept` (what
 * the caller knows beyond the key list: its own session's records, an earlier-format history). A key that is not exactly a
 * label key is never named. Deleting what this names loses no label of an occurrence the store still holds, whoever set it.
 */
export const orphanLabelKeys = (keys: readonly unknown[], isKept: (project: string, id: string) => boolean = () => false): string[] => {
  const held = new Set(keys.filter((k): k is string => typeof k === 'string' && k.startsWith(OCC_PREFIX)))

  return keys.flatMap(k => { const l = parseLabelKey(k); return l !== null && !held.has(occKeyOf(l.project, l.id)) && !isKept(l.project, l.id) ? [k as string] : [] })
}
/**
 * The occurrence ids an earlier-format history value holds for a project (`alert-history:<project>`, or the v0.5.7
 * `alert-history` of every project when `isShared`), derived as a session taking that history up derives them. Null when the
 * value cannot be read: nothing of that project is then called an orphan on a guess.
 */
export const legacyIdsOf = (value: unknown, project: string, isShared: boolean): Set<string> | null => {
  if (value === null || typeof value !== 'object') return null
  const v = value as { v?: unknown; alerts?: unknown; projects?: unknown }
  if (v.v !== 1) return null
  let records: unknown = v.alerts
  if (isShared) {
    if (v.projects === null || typeof v.projects !== 'object') return null
    if (!Object.hasOwn(v.projects, project)) return new Set()
    records = (v.projects as Record<string, unknown>)[project]
  }

  return Array.isArray(records) ? new Set(episodesOf(validAlerts(records)).map(e => e.id)) : null
}

// --- The observed set: the project's bounded history, as one session can read it ---

/**
 * The occurrences the calibration commands read: those other sessions keep in keys of their own (`stored`), then this
 * session's own records, each occurrence once and this session's copy preferred. Acknowledgments the store holds are applied
 * here, in memory. Pure: the records given are not changed and nothing is kept.
 */
export const observedOf = (own: readonly AlertRecord[], stored: readonly { id: string; records: readonly AlertRecord[] }[], acked: ReadonlySet<string>, open: readonly Open[]): Occurrence[] => {
  const mine = occurrencesOf(applyAcks(own, acked), open)
  const have = new Set(mine.map(o => o.id))
  const others: Occurrence[] = []
  for (const s of stored) {
    if (have.has(s.id)) continue
    const o = occurrencesOf(applyAcks(s.records, acked), open).find(x => x.id === s.id)
    if (o === undefined) continue
    others.push(o)
    have.add(s.id)
  }

  return [...others, ...mine]
}

/** One occurrence with the person's label, if it has one. `hasKey`: a label key exists for it, whether or not its value can be read. */
export type Reviewed = { occurrence: Occurrence; label: Label | null; hasKey: boolean }

// --- The simulation: the live policy's own decision, on a frozen copy with notifications on ---

/** What the policy would do with an occurrence: write a notification at once, hold it for quiet hours, or write none. */
export type Outcome = 'notify' | 'defer' | 'none'
/** `why`: quiet hours hold it, its kind is not a notified one, or the configuration given was not one with notifications on. */
export type Simulation = { outcome: Outcome; why: 'quiet' | 'kind-off' | 'off' | null }

/**
 * The alert policy as the options configure it, with notifications on: recording may be on while alerts are off, and the
 * question is what the policy would have done had they been on. A copy, frozen all the way down: the options and the live
 * configuration are read and never written, and the constants a reading can hand back are copied before they are frozen.
 */
export const simulationConfigOf = (options: Readonly<Record<string, unknown>>, zone: string = machineZone()): GuardConfig => {
  const cfg = guardConfigOf({ ...options, guardAlerts: true }, zone)

  return Object.freeze({
    ...cfg,
    kinds: Object.freeze([...cfg.kinds]),
    kindProblems: Object.freeze([...cfg.kindProblems]) as string[],
    quiet: Object.freeze({ ...cfg.quiet, problems: Object.freeze([...cfg.quiet.problems]) as string[] }),
  })
}

/**
 * What the policy would do with one occurrence at the moment it was first recorded. The same two decisions the live pass
 * makes, in its order: whether a first alert is sent at all (`decide`, here with no session state and no earlier record, so
 * no cooldown, budget, silence or retry enters), then whether its kind or quiet hours hold it back (`holdOf`). Pure.
 */
export const simulate = (cfg: GuardConfig, o: Pick<Occurrence, 'key' | 'kind' | 'at'>): Simulation => {
  if (!decide(cfg, EMPTY_GUARD, [], o.key, o.at).send) return { outcome: 'none', why: 'off' }
  const hold = holdOf(cfg, o.kind, o.at)

  return hold === null ? { outcome: 'notify', why: null } : hold === 'quiet' ? { outcome: 'defer', why: 'quiet' } : { outcome: 'none', why: 'kind-off' }
}

// --- The figures: counts first, a rate only with enough behind it ---

/** A rate is shown only when its denominator holds at least this many labelled incidents; below it, the counts and INSUFFICIENT EVIDENCE. */
export const MIN_DENOMINATOR = 10
const Z95 = 1.959963984540054
export type Interval = { low: number; high: number }
/** The 95% Wilson score interval for `k` of `n`, as proportions; null when `k` of `n` is not a count. It stays inside 0 and 1 and is usable at 0 and at `n`. */
export const wilson = (k: number, n: number): Interval | null => {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || n <= 0 || k < 0 || k > n) return null
  const p = k / n
  const z2 = Z95 * Z95
  const scale = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / scale
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / scale

  return { low: k === 0 ? 0 : Math.max(0, centre - half), high: k === n ? 1 : Math.min(1, centre + half) }
}
/** `k` of `n`, and the rate with its interval only when `n` is enough to show one. */
export type Rate = { k: number; n: number; isSufficient: boolean; value: number | null; interval: Interval | null }
export const rateOf = (k: number, n: number): Rate => {
  const interval = n >= MIN_DENOMINATOR ? wilson(k, n) : null

  return interval === null ? { k, n, isSufficient: false, value: null, interval: null } : { k, n, isSufficient: true, value: k / n, interval }
}

export type KindRow = { kind: AlertKind; level: Level; recorded: number; labels: Record<Label, number>; unreviewed: number; simulated: Record<Outcome, number> }
export type Calibration = {
  recorded: number; reviewed: number; unreviewed: number
  /** Label keys whose value this build does not read. They are among the unreviewed, and the report says how many. */
  unreadable: number
  labels: Record<Label, number>
  /** Every recorded occurrence by simulated outcome, reviewed or not. */
  simulated: Record<Outcome, number>
  /** Reviewed, policy would notify at once: labelled NOTIFY (`wanted`), labelled RECORD_ONLY or NOISE (`unwanted`). */
  wanted: number; unwanted: number
  /** Reviewed, policy would write none: labelled NOTIFY (`missed`, a missed wanted notification), labelled otherwise (`spared`). */
  missed: number; spared: number
  /** Reviewed, policy would hold for quiet hours. In neither rate: whether one was told afterwards is not simulated. */
  deferred: { wanted: number; unwanted: number }
  /** `wanted` of the reviewed occurrences the policy would notify at once. */
  precision: Rate
  /** `missed` of the reviewed occurrences labelled NOTIFY that the policy would notify or would not (deferred ones apart). */
  missedShare: Rate
  byKind: KindRow[]
}

/**
 * The counts and the two rates, from the occurrences, their labels and the simulated policy. An unreviewed occurrence is in
 * no cell: it is never assumed to be any label. Pure and deterministic; nothing is stored.
 */
export const calibrationOf = (items: readonly Reviewed[], cfg: GuardConfig): Calibration => {
  const rows = items.map(x => ({ label: x.label, hasKey: x.hasKey, kind: x.occurrence.kind, outcome: simulate(cfg, x.occurrence).outcome }))
  type Row = (typeof rows)[number]
  const n = (f: (r: Row) => boolean, of: readonly Row[] = rows): number => of.filter(f).length
  const isWanted = (r: Row): boolean => r.label === 'NOTIFY'
  const isUnwanted = (r: Row): boolean => r.label === 'RECORD_ONLY' || r.label === 'NOISE'
  const labelsOf = (of: readonly Row[]): Record<Label, number> => ({ NOTIFY: n(r => r.label === 'NOTIFY', of), RECORD_ONLY: n(r => r.label === 'RECORD_ONLY', of), NOISE: n(r => r.label === 'NOISE', of) })
  const simulatedOf = (of: readonly Row[]): Record<Outcome, number> => ({ notify: n(r => r.outcome === 'notify', of), defer: n(r => r.outcome === 'defer', of), none: n(r => r.outcome === 'none', of) })
  const wanted = n(r => isWanted(r) && r.outcome === 'notify')
  const unwanted = n(r => isUnwanted(r) && r.outcome === 'notify')
  const missed = n(r => isWanted(r) && r.outcome === 'none')
  const reviewed = n(r => r.label !== null)

  return {
    recorded: rows.length, reviewed, unreviewed: rows.length - reviewed, unreadable: n(r => r.hasKey && r.label === null),
    labels: labelsOf(rows), simulated: simulatedOf(rows),
    wanted, unwanted, missed, spared: n(r => isUnwanted(r) && r.outcome === 'none'),
    deferred: { wanted: n(r => isWanted(r) && r.outcome === 'defer'), unwanted: n(r => isUnwanted(r) && r.outcome === 'defer') },
    precision: rateOf(wanted, wanted + unwanted), missedShare: rateOf(missed, wanted + missed),
    byKind: PRIORITY.flatMap(kind => {
      const mine = rows.filter(r => r.kind === kind)

      return mine.length === 0 ? [] : [{ kind, level: LEVEL[kind], recorded: mine.length, labels: labelsOf(mine), unreviewed: n(r => r.label === null, mine), simulated: simulatedOf(mine) }]
    }),
  }
}

// --- The report and the review list: counts, closed words, and what was not measured ---

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
/** A rate with the interval and the denominator in words, or the counts and INSUFFICIENT EVIDENCE. Never a bare percentage. */
const rateLine = (name: string, r: Rate, counts: string): string =>
  (r.isSufficient && r.value !== null && r.interval !== null
    ? `${name}: ${pct(r.value)} (95% Wilson interval ${pct(r.interval.low)} to ${pct(r.interval.high)}) · ${counts}`
    : `${name}: INSUFFICIENT EVIDENCE · ${counts} · a rate needs at least ${MIN_DENOMINATOR}`)

/** The simulated policy in closed words: which kinds are notified and what quiet hours do. Read off the frozen copy, never off the clock. */
export const policyText = (cfg: GuardConfig): string[] => {
  const off = KINDS.filter(k => !cfg.kinds.includes(k))
  const q = cfg.quiet
  const mode = (m: 'defer' | 'notify'): string => (m === 'defer' ? 'deferred' : 'sent')
  const lines = [
    off.length === 0 ? '  notified kinds: all five (guardNotifyKinds)' : `  notified kinds: ${[...cfg.kinds].sort(byPriority).join(', ')} · NOT notified: ${[...off].sort(byPriority).join(', ')} (guardNotifyKinds)`,
    ...cfg.kindProblems.map(p => `  WARN ${p}`),
    !q.asked ? '  quiet hours: off (guardQuietHours)'
      : !q.on ? '  quiet hours: NOT IN FORCE, the settings were not understood, so nothing is deferred'
        : `  quiet hours: ${clockOf(q.start)}-${clockOf(q.end)} ${q.zone} (${q.zoneFrom === 'option' ? 'guardQuietTimezone' : 'this machine\'s zone'}) · in the window ordinary alerts are ${mode(q.ordinary)} and critical alerts are ${mode(q.critical)}`,
    ...(q.asked && !q.on ? q.problems.map(p => `  WARN ${p}`) : []),
  ]

  return lines
}

/** What the real settings are, beside the simulated ones: the report never leaves the two to be confused. */
export type RealSettings = { enabled: boolean; recording: boolean }

export const NOT_SIMULATED = 'Not simulated: the cooldown between alerts, the alert budget of a session, reminders, a silence, a notification that failed to send and its retries, and whether a deferred alert was told after quiet hours ended. Each incident is judged on its own, at the moment it was recorded.'

/**
 * `/cockpit alerts calibration`. Counts, two rates with what they are a share of, and what was not measured. It holds no id,
 * key or text from a record, proposes no setting, and says nothing about an event that was never recorded. Lines are not cut
 * to a width: a denominator or a limit that was cut off would be a different statement.
 */
export const calibrationText = (c: Calibration, cfg: GuardConfig, real: RealSettings): string => {
  const lines = [`GUARD CALIBRATION · simulated, nothing sent · ${c.recorded} recorded · ${c.reviewed} reviewed · ${c.unreviewed} unreviewed`]
  lines.push('Observed: the incidents in this project\'s bounded history. An event Cockpit never recorded is in no figure here.')
  lines.push(`Simulated policy · notifications are treated as on for this report only; guardAlerts is ${real.enabled ? 'on' : 'off'}${real.enabled ? '' : real.recording ? ' (recording only)' : ''} and was not changed:`)
  lines.push(...policyText(cfg))
  if (c.recorded === 0) {
    lines.push('Nothing recorded, so there is nothing to simulate. An incident is recorded when a run needs a person, with guardAlerts or guardRecordOnly on.')
    lines.push('Nothing was sent or changed.')

    return lines.join('\n')
  }
  lines.push(`All ${c.recorded} recorded, by simulated outcome: would notify ${c.simulated.notify} · would defer for quiet hours ${c.simulated.defer} · would not notify ${c.simulated.none}`)
  lines.push(`Reviewed ${c.reviewed} · your label against the simulated outcome:`)
  lines.push(`  wanted, would notify: ${c.wanted}`)
  lines.push(`  not wanted, would notify (an unwanted notification): ${c.unwanted}`)
  lines.push(`  wanted, would not notify (a missed wanted notification): ${c.missed}`)
  lines.push(`  not wanted, would not notify: ${c.spared}`)
  lines.push(`  deferred for quiet hours: ${c.deferred.wanted + c.deferred.unwanted} (wanted ${c.deferred.wanted} · not wanted ${c.deferred.unwanted}) · in neither rate; whether one was told afterwards is not simulated`)
  lines.push(`  labelled NOISE: ${c.labels.NOISE} · judged not useful as an incident, which is about what is recorded, not about notifying`)
  lines.push(`Unreviewed ${c.unreviewed} · in no figure below, and not assumed to be any label.${c.unreadable > 0 ? ` ${plural(c.unreadable, 'stored label', 'stored labels')} could not be read and ${c.unreadable === 1 ? 'is' : 'are'} counted here.` : ''}`)
  lines.push(rateLine('Simulated notification precision', c.precision, `${c.precision.k} wanted of ${plural(c.precision.n, 'reviewed incident', 'reviewed incidents')} the policy would notify`))
  lines.push(rateLine('Missed-wanted share', c.missedShare, `${c.missedShare.k} not notified of ${plural(c.missedShare.n, 'reviewed incident', 'reviewed incidents')} labelled NOTIFY, deferred ones apart`))
  lines.push('  The missed-wanted share is a share of recorded, reviewed incidents. Cockpit cannot measure the incidents it never recorded.')
  lines.push('  INSUFFICIENT EVIDENCE means too few labelled incidents for a rate. It is not a finding about the policy.')
  lines.push('By kind:')
  for (const k of c.byKind) lines.push(`  ${k.level} ${k.kind} · ${k.recorded} recorded · NOTIFY ${k.labels.NOTIFY} · RECORD_ONLY ${k.labels.RECORD_ONLY} · NOISE ${k.labels.NOISE} · unreviewed ${k.unreviewed} · would notify ${k.simulated.notify} · defer ${k.simulated.defer} · not notify ${k.simulated.none}`)
  if (c.byKind.some(k => isCritical(k.kind))) lines.push('  security-failure is critical: it is always a notified kind while alerts are on and cannot be turned off. A label on one is shown as you gave it and changes nothing about that.')
  lines.push(NOT_SIMULATED)
  lines.push('Nothing was sent or changed: no notification, sound or bell, and no setting, acknowledgment, gate, review, hold or release. What to make of these figures is yours to decide.')
  lines.push('Label incidents: /cockpit alerts review · /cockpit alerts label <id> notify|record|noise|clear')

  return lines.join('\n')
}

const CONDITION: Readonly<Record<Standing, string>> = { OPEN: 'condition OPEN now', CLEARED: 'condition no longer open (observed not holding)', RESOLVED: 'condition no longer open (recorded resolved)', UNKNOWN: 'condition state UNKNOWN from this session' }
/** Unreviewed first, then reviewed; within each the gravest kind first, then the latest recorded. A stable order whatever the store lists. */
export const reviewOrder = (items: readonly Reviewed[]): Reviewed[] =>
  [...items].sort((a, b) => Number(a.label !== null) - Number(b.label !== null) || byPriority(a.occurrence.kind, b.occurrence.kind) || b.occurrence.at - a.occurrence.at || (a.occurrence.id < b.occurrence.id ? -1 : a.occurrence.id > b.occurrence.id ? 1 : 0))
export const reviewPages = (n: number): number => Math.max(1, Math.ceil(n / INBOX_PAGE))
export const LABEL_USAGE = 'Usage: /cockpit alerts label <id> notify|record|noise|clear  (the 8-character id listed by /cockpit alerts review)'

/**
 * `/cockpit alerts review`, one page of it: the occurrences with no label first, then the labelled ones with their label. Each
 * line carries what the inbox shows (id, level, kind, task, the moment it was recorded, whether it was acknowledged, whether
 * its condition holds now) and nothing else from a record. It is a list to label from, not a look: it marks nothing as shown.
 */
export const reviewText = (items: readonly Reviewed[], page: number, now: number, obs: Observation): string => {
  const ordered = reviewOrder(items)
  const pages = reviewPages(ordered.length)
  const at = Math.min(Math.max(1, page), pages)
  const reviewed = ordered.filter(x => x.label !== null).length
  const lines = [`ALERT REVIEW · ${ordered.length} recorded · ${reviewed} reviewed · ${ordered.length - reviewed} unreviewed · page ${at} of ${pages}`]
  if (ordered.length === 0) lines.push('Nothing recorded. An incident is recorded when a run needs a person, with guardAlerts or guardRecordOnly on.')
  let group = ''
  for (const x of ordered.slice((at - 1) * INBOX_PAGE, at * INBOX_PAGE)) {
    const o = x.occurrence
    const g = x.label === null ? 'UNREVIEWED (no notification preference recorded)' : 'REVIEWED (your label)'
    if (g !== group) { lines.push(g); group = g }
    lines.push(`  ${o.id} ${o.level} ${o.kind} · task ${o.taskId} · recorded ${stamp(o.at)}${ageOf(now - o.at)} · ${o.acked ? 'acknowledged' : 'not acknowledged'} · ${CONDITION[standingOf(o, obs)]}${x.label !== null ? ` · labelled ${x.label}` : x.hasKey ? ' · its stored label could not be read' : ''}`)
  }
  if (pages > 1) lines.push(`More: /cockpit alerts review ${at < pages ? at + 1 : 1}`)
  lines.push(`Label one: /cockpit alerts label <id> notify|record|noise|clear · notify: ${LABEL_MEANING.NOTIFY}; record: ${LABEL_MEANING.RECORD_ONLY}; noise: ${LABEL_MEANING.NOISE}.`)
  lines.push('A label acknowledges nothing, resolves nothing, sends nothing and changes no setting. This list is not a look: SINCE LAST LOOK is unchanged. The report: /cockpit alerts calibration')

  return lines.join('\n')
}
