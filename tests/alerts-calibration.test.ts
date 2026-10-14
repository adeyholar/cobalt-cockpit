// v0.6.3 Cobalt Guard Calibration, the pure parts: the label vocabulary and its keys, the orphan rule, the observed set, the
// frozen simulation and its agreement with the live policy, the Wilson interval and the threshold, and the wording rules of the
// report and the review list. Synthetic: nothing here shows that a person saw anything, and nothing here can notify.

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_GUARD, KINDS, PRIORITY, bounded, decide, episodesOf, guardConfigOf, holdOf, occKeyOf, occurrencesOf } from '../hooks/alerts'
import type { AlertKind, AlertRecord, GuardConfig, Occurrence } from '../hooks/alerts'
import { LABELS, LABEL_MEANING, LABEL_PREFIX, MIN_DENOMINATOR, NOT_SIMULATED, calibrationOf, calibrationText, labelKeyOf, labelOfValue, labelOfWord, labelValueOf, labelledIdsOf, legacyIdsOf, observedOf, orphanLabelKeys, parseLabelKey, policyText, rateOf, reviewOrder, reviewText, simulate, simulationConfigOf, wilson } from '../hooks/calibration'
import type { Label, Reviewed } from '../hooks/calibration'
import { QUIET_OFF, isQuiet } from '../hooks/quiet'

const P = 'a1b2c3d4e5f6'
const Q = '0123456789ab'
const DETAIL: Record<AlertKind, string> = { 'security-failure': 'SECURITY', 'release-no-go': 'release', 'verification-exhausted': 'TEST', 'review-hold': 'review', 'run-blocked': 'task' }
const keyOf = (n: number, kind: AlertKind): string => `${n}@${n}:${kind}:${DETAIL[kind]}`
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'recorded', attempts: 0, channel: null, ...over })
const occ = (n: number, kind: AlertKind = 'run-blocked', at = 1_000_000 + n): Occurrence => occurrencesOf(bounded([], rec(keyOf(n, kind), { kind, taskId: n, at })), [])[0]!
const item = (o: Occurrence, label: Label | null = null, hasKey = label !== null): Reviewed => ({ occurrence: o, label, hasKey })
/** A small deterministic generator, so the sweeps are reproducible. */
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
const pickOf = (next: () => number) => <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
const cfgOf = (options: Record<string, unknown> = {}): GuardConfig => simulationConfigOf(options, 'UTC')
const QUIET = { guardQuietHours: '00:00-00:30', guardQuietTimezone: 'UTC' }
/** 00:16:40 UTC, inside the quiet window above; an hour later, outside it. */
const IN = 1_000_000
const OUT = IN + 3_600_000
const NONE = { uid: null, blind: [] }
const REAL = { enabled: false, recording: true }
/** `actual` within half a unit of the `digits`-th decimal of `expected`. */
const near = (actual: number, expected: number, digits: number): void => expect(Math.abs(actual - expected)).toBeLessThan(0.5 * 10 ** -digits)

describe('the label vocabulary', () => {
  test('the four words a person types, and nothing else', () => {
    expect(labelOfWord('notify')).toBe('NOTIFY')
    expect(labelOfWord('record')).toBe('RECORD_ONLY')
    expect(labelOfWord('noise')).toBe('NOISE')
    expect(labelOfWord('clear')).toBe('clear')
    for (const bad of ['NOTIFY', 'Notify', ' notify', 'notify ', 'notif', 'record_only', 'RECORD_ONLY', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', undefined, null, 1, ['notify'], { toString: () => 'notify' }]) expect(labelOfWord(bad)).toBeNull()
  })
  test('three labels, each with a meaning of its own', () => {
    expect([...LABELS]).toEqual(['NOTIFY', 'RECORD_ONLY', 'NOISE'])
    expect(Object.keys(LABEL_MEANING).sort()).toEqual([...LABELS].sort())
    expect(new Set(Object.values(LABEL_MEANING)).size).toBe(3)
  })
})

describe('label keys', () => {
  test('one key per occurrence, read back as its project and id', () => {
    expect(labelKeyOf(P, 'deadbeef')).toBe(`alert-label:${P}:deadbeef`)
    expect(LABEL_PREFIX).toBe('alert-label:')
    expect(parseLabelKey(labelKeyOf(P, 'deadbeef'))).toEqual({ project: P, id: 'deadbeef' })
  })
  test('a key that is not exactly a label key is not read as one', () => {
    for (const bad of [`${LABEL_PREFIX}${P}:deadbeef:x`, `${LABEL_PREFIX}${P}:DEADBEEF`, `${LABEL_PREFIX}${P}:deadbee`, `${LABEL_PREFIX}${P}:deadbeef0`, `${LABEL_PREFIX}${P}0:deadbeef`, `${LABEL_PREFIX}${P.toUpperCase()}:deadbeef`,
      `${LABEL_PREFIX}../x:deadbeef`, `alert-ack:${P}:deadbeef`, occKeyOf(P, 'deadbeef'), LABEL_PREFIX, `${LABEL_PREFIX}${P}`, 7, null, undefined, {}]) expect(parseLabelKey(bad)).toBeNull()
  })
  test('the labelled ids of a project, and of no other', () => {
    const keys: unknown[] = [labelKeyOf(P, '0000000a'), labelKeyOf(Q, '0000000b'), `alert-ack:${P}:0000000c`, occKeyOf(P, '0000000d'), 'alert-label:zz', 42, null]
    expect([...labelledIdsOf(keys, P)]).toEqual(['0000000a'])
    expect([...labelledIdsOf(keys, Q)]).toEqual(['0000000b'])
    expect([...labelledIdsOf(keys, 'ffffffffffff')]).toEqual([])
  })
})

describe('the stored value', () => {
  test('a label, a version and a time: nothing else has a field to be in', () => {
    for (const label of LABELS) {
      const value = labelValueOf(label, 1234)
      expect(Object.keys(value)).toEqual(['v', 'label', 'at'])
      expect(JSON.stringify(value)).toMatch(/^\{"v":1,"label":"(NOTIFY|RECORD_ONLY|NOISE)","at":\d+\}$/)
      expect(labelOfValue(value)).toBe(label)
      expect(labelOfValue(JSON.parse(JSON.stringify(value)))).toBe(label)
    }
  })
  test('a value this build did not write is not believed', () => {
    for (const bad of [{ v: 1, label: 'NOTIFY', at: 1, note: 'free text' }, { v: 2, label: 'NOTIFY', at: 1 }, { v: '1', label: 'NOTIFY', at: 1 }, { v: 1, label: 'URGENT', at: 1 }, { v: 1, label: 'notify', at: 1 },
      { v: 1, label: ['NOTIFY'], at: 1 }, { v: 1, label: 'NOTIFY', at: Number.NaN }, { v: 1, label: 'NOTIFY', at: Number.POSITIVE_INFINITY }, { v: 1, label: 'NOTIFY', at: '1' }, { v: 1, label: 'NOTIFY' },
      ['NOTIFY'], 'NOTIFY', 7, null, undefined, { label: 'NOTIFY' }]) expect(labelOfValue(bad)).toBeNull()
  })
})

describe('orphaned labels', () => {
  test('a label is kept while its occurrence key is listed, in its own project only', () => {
    const keys = [occKeyOf(P, '0000000a'), labelKeyOf(P, '0000000a'), labelKeyOf(Q, '0000000a'), labelKeyOf(P, '0000000b')]
    expect(orphanLabelKeys(keys)).toEqual([labelKeyOf(Q, '0000000a'), labelKeyOf(P, '0000000b')])
  })
  test('what the caller still holds is kept, and keys that are not label keys are never named', () => {
    const keys: unknown[] = [labelKeyOf(P, '0000000b'), 'alert-label:zz', `${LABEL_PREFIX}${P}:0000000c:x`, `alert-ack:${P}:0000000d`, `alert-seen:${P}`, 'ledger:s1', 7, null]
    expect(orphanLabelKeys(keys, (p, id) => p === P && id === '0000000b')).toEqual([])
    expect(orphanLabelKeys(keys)).toEqual([labelKeyOf(P, '0000000b')])
  })
  test('sweep: a label whose occurrence key is listed is never named, every name is a label key, and every orphan is named', () => {
    const next = lcg(20261014)
    const ids = ['00000001', '0000000a', 'deadbeef', 'cafef00d', '12345678', 'abcdef01']
    for (let n = 0; n < 300; n++) {
      const keys: unknown[] = []
      for (const p of [P, Q]) for (const id of ids) {
        if (next() < 0.5) keys.push(occKeyOf(p, id))
        if (next() < 0.5) keys.push(labelKeyOf(p, id))
        if (next() < 0.2) keys.push(`alert-ack:${p}:${id}`)
      }
      if (next() < 0.3) keys.push('alert-label:zz', `${LABEL_PREFIX}${P}:deadbeef:x`, 7, null)
      const held = new Set(ids.filter(() => next() < 0.3))
      const isKept = (p: string, id: string): boolean => p === P && held.has(id)
      const named = orphanLabelKeys(keys, isKept)
      for (const k of named) {
        const l = parseLabelKey(k)
        expect(l).not.toBeNull()
        expect(keys.includes(occKeyOf(l!.project, l!.id))).toBe(false)
        expect(isKept(l!.project, l!.id)).toBe(false)
      }
      for (const k of keys) {
        const l = parseLabelKey(k)
        if (l !== null && !keys.includes(occKeyOf(l.project, l.id)) && !isKept(l.project, l.id)) expect(named).toContain(k as string)
      }
    }
  })
})

describe('earlier-format histories', () => {
  const records = [...bounded([], rec(keyOf(1, 'run-blocked'), { at: 1000 })), ...bounded([], rec(keyOf(2, 'review-hold'), { kind: 'review-hold', taskId: 2, at: 2000 }))]
  const want = episodesOf(records).map(e => e.id).sort()
  test('the ids a session taking the history up would derive, in either format', () => {
    expect([...legacyIdsOf({ v: 1, alerts: records }, P, false)!].sort()).toEqual(want)
    expect([...legacyIdsOf({ v: 1, projects: { [P]: records } }, P, true)!].sort()).toEqual(want)
    expect([...legacyIdsOf({ v: 1, projects: { [Q]: records } }, P, true)!]).toEqual([])
  })
  test('a value that cannot be read is null, so nothing of its project is called an orphan', () => {
    for (const bad of [null, undefined, 'x', 7, { v: 2, alerts: records }, { v: 1, alerts: 'no' }, { v: 1 }]) expect(legacyIdsOf(bad, P, false)).toBeNull()
    for (const bad of [{ v: 1, projects: null }, { v: 1, projects: 'x' }, { v: 1, projects: { [P]: 'no' } }, { v: 2, projects: { [P]: records } }]) expect(legacyIdsOf(bad, P, true)).toBeNull()
  })
})

describe('the observed set', () => {
  const mine = bounded([], rec(keyOf(1, 'run-blocked'), { taskId: 1, at: 1000 }))
  const mineId = episodesOf(mine)[0]!.id
  const theirs = bounded([], rec(keyOf(2, 'review-hold'), { kind: 'review-hold', taskId: 2, at: 2000 }))
  const theirsId = episodesOf(theirs)[0]!.id
  test('another session\'s occurrences first, each once, this session\'s copy preferred, acknowledgments applied in memory only', () => {
    const stale = [...mine, rec(keyOf(1, 'run-blocked'), { taskId: 1, at: 1500, id: mineId })]
    const before = JSON.stringify([mine, theirs, stale])
    const out = observedOf(mine, [{ id: theirsId, records: theirs }, { id: mineId, records: stale }], new Set([theirsId]), [])
    expect(out.map(o => o.id)).toEqual([theirsId, mineId])
    expect(out.find(o => o.id === mineId)!.lastAt).toBe(1000)
    expect(out.find(o => o.id === theirsId)!.acked).toBe(true)
    expect(out.find(o => o.id === mineId)!.acked).toBe(false)
    expect(JSON.stringify([mine, theirs, stale])).toBe(before)
  })
  test('a condition that holds now is open in whichever copy holds it', () => {
    const out = observedOf(mine, [{ id: theirsId, records: theirs }], new Set(), [{ kind: 'review-hold', key: keyOf(2, 'review-hold') }])
    expect(out.find(o => o.id === theirsId)!.state).toBe('open')
    expect(out.find(o => o.id === mineId)!.state).toBe('ended')
  })
  test('a stored part that is not the occurrence its key names adds nothing', () => {
    expect(observedOf([], [{ id: 'deadbeef', records: theirs }], new Set(), [])).toEqual([])
  })
})

describe('the simulation configuration', () => {
  test('notifications are on whatever guardAlerts says, and the rest is read as the live policy reads it', () => {
    for (const options of [{}, { guardAlerts: false }, { guardAlerts: true }, { guardRecordOnly: true }, { guardAlerts: false, guardRecordOnly: true }]) expect(cfgOf(options).enabled).toBe(true)
    const options = { guardNotifyKinds: 'release-no-go', guardQuietHours: '22:00-07:00', guardQuietTimezone: 'Europe/Berlin', guardQuietCritical: 'defer' }
    const live = guardConfigOf({ ...options, guardAlerts: true }, 'UTC')
    expect([...cfgOf(options).kinds]).toEqual([...live.kinds])
    expect(JSON.stringify(cfgOf(options).quiet)).toBe(JSON.stringify(live.quiet))
  })
  test('frozen all the way down', () => {
    const cfg = cfgOf({ guardNotifyKinds: 'bogus', guardQuietHours: 'nonsense' })
    for (const part of [cfg, cfg.kinds, cfg.kindProblems, cfg.quiet, cfg.quiet.problems]) expect(Object.isFrozen(part)).toBe(true)
    expect(() => { (cfg as { enabled: boolean }).enabled = false }).toThrow()
    expect(() => { (cfg.kinds as AlertKind[]).push('run-blocked') }).toThrow()
    expect(() => { (cfg.quiet as { on: boolean }).on = true }).toThrow()
    expect(cfg.enabled).toBe(true)
  })
  test('the options are read and never written', () => {
    const options: Record<string, unknown> = { guardRecordOnly: true, guardNotifyKinds: 'none' }
    const before = JSON.stringify(options)
    cfgOf(options)
    expect(JSON.stringify(options)).toBe(before)
    expect('guardAlerts' in options).toBe(false)
    expect(guardConfigOf(options, 'UTC').enabled).toBe(false)
  })
  test('the shared constants a reading can hand back are copied, not frozen', () => {
    cfgOf({})
    cfgOf({ guardQuietHours: '' })
    expect(Object.isFrozen(KINDS)).toBe(false)
    expect(Object.isFrozen(QUIET_OFF)).toBe(false)
    expect(Object.isFrozen(QUIET_OFF.problems)).toBe(false)
  })
})

describe('simulate', () => {
  test('with no setting every kind is notified at once', () => {
    for (const kind of KINDS) expect(simulate(cfgOf(), { key: keyOf(1, kind), kind, at: IN })).toEqual({ outcome: 'notify', why: null })
  })
  test('security-failure is notified when no kind is chosen, and is then the only one', () => {
    const cfg = cfgOf({ guardNotifyKinds: 'none' })
    for (const kind of KINDS) expect(simulate(cfg, { key: keyOf(1, kind), kind, at: OUT })).toEqual(kind === 'security-failure' ? { outcome: 'notify', why: null } : { outcome: 'none', why: 'kind-off' })
  })
  test('a kind left out is not notified; a kind named is', () => {
    const cfg = cfgOf({ guardNotifyKinds: 'release-no-go' })
    expect(simulate(cfg, { key: keyOf(1, 'release-no-go'), kind: 'release-no-go', at: OUT }).outcome).toBe('notify')
    expect(simulate(cfg, { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: OUT })).toEqual({ outcome: 'none', why: 'kind-off' })
    expect(simulate(cfg, { key: keyOf(1, 'security-failure'), kind: 'security-failure', at: OUT }).outcome).toBe('notify')
  })
  test('in quiet hours an ordinary alert is deferred and a critical one sent, by default', () => {
    const cfg = cfgOf(QUIET)
    expect(simulate(cfg, { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: IN })).toEqual({ outcome: 'defer', why: 'quiet' })
    expect(simulate(cfg, { key: keyOf(1, 'release-no-go'), kind: 'release-no-go', at: IN })).toEqual({ outcome: 'defer', why: 'quiet' })
    expect(simulate(cfg, { key: keyOf(1, 'security-failure'), kind: 'security-failure', at: IN })).toEqual({ outcome: 'notify', why: null })
    expect(simulate(cfg, { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: OUT })).toEqual({ outcome: 'notify', why: null })
  })
  test('the two modes decide what each class does in the window', () => {
    expect(simulate(cfgOf({ ...QUIET, guardQuietCritical: 'defer' }), { key: keyOf(1, 'security-failure'), kind: 'security-failure', at: IN }).outcome).toBe('defer')
    expect(simulate(cfgOf({ ...QUIET, guardQuietOrdinary: 'notify' }), { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: IN }).outcome).toBe('notify')
  })
  test('a window that crosses midnight holds on both sides of it, and its end is outside', () => {
    const cfg = cfgOf({ guardQuietHours: '23:00-00:30', guardQuietTimezone: 'UTC' })
    const at = (iso: string) => simulate(cfg, { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: Date.parse(iso) }).outcome
    expect(at('1970-01-01T23:30:00Z')).toBe('defer')
    expect(at('1970-01-02T00:20:00Z')).toBe('defer')
    expect(at('1970-01-02T00:30:00Z')).toBe('notify')
    expect(at('1970-01-01T22:59:00Z')).toBe('notify')
  })
  test('the window is read by the wall clock of the zone it names, daylight saving included', () => {
    const berlin = cfgOf({ guardQuietHours: '22:00-07:00', guardQuietTimezone: 'Europe/Berlin' })
    const utc = cfgOf({ guardQuietHours: '22:00-07:00', guardQuietTimezone: 'UTC' })
    const one = (cfg: GuardConfig, iso: string) => simulate(cfg, { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: Date.parse(iso) }).outcome
    // 21:30 UTC in January is 22:30 in Berlin (CET); 20:30 UTC in July is 22:30 there (CEST)
    expect(one(berlin, '2026-01-15T21:30:00Z')).toBe('defer')
    expect(one(utc, '2026-01-15T21:30:00Z')).toBe('notify')
    expect(one(berlin, '2026-07-15T20:30:00Z')).toBe('defer')
    expect(one(utc, '2026-07-15T20:30:00Z')).toBe('notify')
  })
  test('a setting that is not understood never defers anything', () => {
    for (const options of [{ guardQuietHours: 'nonsense' }, { ...QUIET, guardQuietTimezone: 'Mars/Olympus_Mons' }, { ...QUIET, guardQuietOrdinary: 'sometimes' }, { guardQuietHours: '00:00-00:00', guardQuietTimezone: 'UTC' }]) {
      expect(simulate(cfgOf(options), { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: IN }).outcome).toBe('notify')
    }
  })
  test('a configuration with notifications off is never read as sending', () => {
    expect(simulate(guardConfigOf({}, 'UTC'), { key: keyOf(1, 'run-blocked'), kind: 'run-blocked', at: IN })).toEqual({ outcome: 'none', why: 'off' })
  })
  test('sweep: the simulation is the live first-alert decision with no session state, then the live hold', () => {
    const next = lcg(77)
    const pick = pickOf(next)
    for (let n = 0; n < 400; n++) {
      const options: Record<string, unknown> = {
        guardNotifyKinds: pick(['', 'all', 'none', 'bogus', 'release-no-go', 'run-blocked, review-hold', 'verification-exhausted,security-failure']),
        guardQuietHours: pick(['', '22:00-07:00', '00:00-23:59', '12:00-13:00', '00:00-00:30', 'nonsense']),
        guardQuietTimezone: 'UTC',
        guardQuietOrdinary: pick(['defer', 'notify']),
        guardQuietCritical: pick(['defer', 'notify']),
        ...(next() < 0.5 ? { guardRecordOnly: true } : {}),
      }
      const cfg = cfgOf(options)
      const kind = pick(KINDS)
      const at = Math.floor(next() * 7 * 86_400_000)
      const key = keyOf(n, kind)
      const sim = simulate(cfg, { key, kind, at })
      expect(decide(cfg, EMPTY_GUARD, [], key, at)).toEqual({ send: true, attempts: 1 })
      const hold = holdOf(cfg, kind, at)
      expect(sim).toEqual(hold === null ? { outcome: 'notify', why: null } : hold === 'quiet' ? { outcome: 'defer', why: 'quiet' } : { outcome: 'none', why: 'kind-off' })
      if (kind === 'security-failure') expect(sim.why).not.toBe('kind-off')
      if (sim.outcome === 'defer') expect(isQuiet(cfg.quiet, at)).toBe(true)
    }
  })
})

describe('the Wilson interval and the threshold', () => {
  const reference = (k: number, n: number) => {
    const z = 1.959963984540054
    const p = k / n
    const d = 1 + (z * z) / n
    const c = (p + (z * z) / (2 * n)) / d
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d

    return { low: c - h, high: c + h }
  }
  test('known values, and the closed form', () => {
    const r = wilson(8, 12)!
    near(r.low, 0.3906, 3)
    near(r.high, 0.8619, 3)
    near(wilson(0, 10)!.high, 0.2775, 3)
    for (const [k, n] of [[1, 10], [5, 10], [9, 10], [3, 17], [20, 32]] as const) {
      const w = wilson(k, n)!
      near(w.low, reference(k, n).low, 10)
      near(w.high, reference(k, n).high, 10)
    }
  })
  test('inside 0 and 1, around the observed share, exact at both ends, symmetric', () => {
    for (let n = 1; n <= 60; n++) {
      expect(wilson(0, n)!.low).toBe(0)
      expect(wilson(n, n)!.high).toBe(1)
      for (let k = 0; k <= n; k++) {
        const w = wilson(k, n)!
        expect(w.low).toBeGreaterThanOrEqual(0)
        expect(w.high).toBeLessThanOrEqual(1)
        expect(w.low).toBeLessThanOrEqual(k / n + 1e-12)
        expect(w.high).toBeGreaterThanOrEqual(k / n - 1e-12)
        near(w.low, 1 - wilson(n - k, n)!.high, 12)
      }
    }
  })
  test('narrower with more observations at the same share', () => {
    const widths = [10, 20, 40, 80].map(n => { const w = wilson(n / 2, n)!; return w.high - w.low })
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThan(widths[i - 1]!)
  })
  test('what is not a count has no interval', () => {
    for (const [k, n] of [[0, 0], [1, 0], [11, 10], [-1, 10], [1.5, 10], [Number.NaN, 10], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]] as const) expect(wilson(k, n)).toBeNull()
  })
  test('a rate needs ten in its denominator; below that there is no rate and no interval', () => {
    expect(MIN_DENOMINATOR).toBe(10)
    for (let n = 0; n < 10; n++) for (let k = 0; k <= n; k++) expect(rateOf(k, n)).toEqual({ k, n, isSufficient: false, value: null, interval: null })
    expect(rateOf(7, 10)).toEqual({ k: 7, n: 10, isSufficient: true, value: 0.7, interval: wilson(7, 10) })
    expect(rateOf(0, 10).isSufficient).toBe(true)
  })
})

describe('the figures', () => {
  const cfg = cfgOf({ guardNotifyKinds: 'release-no-go', ...QUIET })
  const items = (): Reviewed[] => [
    item(occ(1, 'security-failure', IN), 'NOTIFY'),
    item(occ(2, 'security-failure', IN), 'NOISE'),
    item(occ(3, 'release-no-go', OUT), 'RECORD_ONLY'),
    item(occ(4, 'release-no-go', OUT), 'NOTIFY'),
    item(occ(5, 'release-no-go', IN), 'NOTIFY'),
    item(occ(6, 'release-no-go', IN), 'NOISE'),
    item(occ(7, 'run-blocked', OUT), 'NOTIFY'),
    item(occ(8, 'review-hold', OUT), 'RECORD_ONLY'),
    item(occ(9, 'run-blocked', IN)),
    item(occ(10, 'verification-exhausted', OUT), null, true),
  ]
  test('each reviewed incident in exactly one cell, deferred ones apart', () => {
    const c = calibrationOf(items(), cfg)
    expect(c).toMatchObject({
      recorded: 10, reviewed: 8, unreviewed: 2, unreadable: 1,
      labels: { NOTIFY: 4, RECORD_ONLY: 2, NOISE: 2 }, simulated: { notify: 4, defer: 2, none: 4 },
      wanted: 2, unwanted: 2, missed: 1, spared: 1, deferred: { wanted: 1, unwanted: 1 },
    })
    expect(c.precision).toEqual(rateOf(2, 4))
    expect(c.missedShare).toEqual(rateOf(1, 3))
    expect(c.byKind.map(k => k.kind)).toEqual(['security-failure', 'release-no-go', 'verification-exhausted', 'review-hold', 'run-blocked'])
    expect(c.byKind[0]).toEqual({ kind: 'security-failure', level: 'CRITICAL', recorded: 2, labels: { NOTIFY: 1, RECORD_ONLY: 0, NOISE: 1 }, unreviewed: 0, simulated: { notify: 2, defer: 0, none: 0 } })
  })
  test('an unreviewed incident is in no cell and in neither rate, whatever the policy would do', () => {
    const c = calibrationOf(items().map(x => ({ ...x, label: null })), cfg)
    expect(c).toMatchObject({ reviewed: 0, unreviewed: 10, wanted: 0, unwanted: 0, missed: 0, spared: 0, deferred: { wanted: 0, unwanted: 0 } })
    expect(c.precision.n).toBe(0)
    expect(c.missedShare.n).toBe(0)
    expect(c.simulated).toEqual({ notify: 4, defer: 2, none: 4 })
  })
  test('a kind with no incident has no row', () => {
    expect(calibrationOf([item(occ(1, 'run-blocked'), 'NOTIFY')], cfgOf()).byKind.map(k => k.kind)).toEqual(['run-blocked'])
    expect(calibrationOf([], cfgOf()).byKind).toEqual([])
  })
  test('sweep: the cells add up, the rates are over their own cells, and the order of the incidents changes nothing', () => {
    const next = lcg(9)
    const pick = pickOf(next)
    for (let n = 0; n < 300; n++) {
      const list: Reviewed[] = []
      for (let i = 0, m = Math.floor(next() * 40); i < m; i++) {
        const label = next() < 0.4 ? null : pick(LABELS)
        list.push(item(occ(i + 1, pick(KINDS), Math.floor(next() * 2 * 86_400_000)), label, label !== null || next() < 0.2))
      }
      const config = cfgOf({ guardNotifyKinds: pick(['', 'none', 'release-no-go,run-blocked']), guardQuietHours: pick(['', '22:00-07:00', '06:00-18:00']), guardQuietTimezone: 'UTC', guardQuietCritical: pick(['defer', 'notify']) })
      const c = calibrationOf(list, config)
      expect(c.wanted + c.unwanted + c.missed + c.spared + c.deferred.wanted + c.deferred.unwanted).toBe(c.reviewed)
      expect(c.reviewed + c.unreviewed).toBe(c.recorded)
      expect(c.recorded).toBe(list.length)
      expect(c.simulated.notify + c.simulated.defer + c.simulated.none).toBe(c.recorded)
      expect(c.labels.NOTIFY + c.labels.RECORD_ONLY + c.labels.NOISE).toBe(c.reviewed)
      expect(c.byKind.reduce((s, k) => s + k.recorded, 0)).toBe(c.recorded)
      expect(c.precision.n).toBe(c.wanted + c.unwanted)
      expect(c.missedShare.n).toBe(c.wanted + c.missed)
      expect(c.precision.isSufficient).toBe(c.precision.n >= MIN_DENOMINATOR)
      expect(c.missedShare.isSufficient).toBe(c.missedShare.n >= MIN_DENOMINATOR)
      const shuffled = [...list].sort(() => next() - 0.5)
      expect(JSON.stringify(calibrationOf(shuffled, config))).toBe(JSON.stringify(c))
    }
  })
})

describe('the report', () => {
  const twelve = (label: Label): Reviewed[] => Array.from({ length: 12 }, (_, i) => item(occ(i + 1, 'security-failure', OUT), label))
  test('below ten a rate is the counts and INSUFFICIENT EVIDENCE, and no percentage appears', () => {
    const cfg = cfgOf()
    const text = calibrationText(calibrationOf([item(occ(1), 'NOTIFY'), item(occ(2), 'NOISE'), item(occ(3))], cfg), cfg, REAL)
    expect(text).toContain('Simulated notification precision: INSUFFICIENT EVIDENCE · 1 wanted of 2 reviewed incidents the policy would notify · a rate needs at least 10')
    expect(text).toContain('Missed-wanted share: INSUFFICIENT EVIDENCE · 0 not notified of 1 reviewed incident labelled NOTIFY, deferred ones apart · a rate needs at least 10')
    expect(text).not.toContain('%')
    expect(text).toContain('It is not a finding about the policy.')
  })
  test('from ten a rate is shown with its 95% Wilson interval and its counts in words', () => {
    const cfg = cfgOf()
    const text = calibrationText(calibrationOf([...twelve('NOTIFY'), item(occ(20), 'NOISE')], cfg), cfg, REAL)
    const w = wilson(12, 13)!
    expect(text).toContain(`Simulated notification precision: ${(1200 / 13).toFixed(1)}% (95% Wilson interval ${(w.low * 100).toFixed(1)}% to ${(w.high * 100).toFixed(1)}%) · 12 wanted of 13 reviewed incidents the policy would notify`)
    expect(text).toContain('Missed-wanted share: 0.0% (95% Wilson interval 0.0% to ')
    expect(text).toContain('· 0 not notified of 12 reviewed incidents labelled NOTIFY, deferred ones apart')
    for (const line of text.split('\n').filter(l => l.includes('%'))) expect(line).toContain(' of ')
  })
  test('with nothing recorded there is nothing to simulate, and it says so', () => {
    const cfg = cfgOf()
    const text = calibrationText(calibrationOf([], cfg), cfg, REAL)
    expect(text).toContain('GUARD CALIBRATION · simulated, nothing sent · 0 recorded · 0 reviewed · 0 unreviewed')
    expect(text).toContain('Nothing recorded, so there is nothing to simulate.')
    expect(text).toContain('Nothing was sent or changed.')
    expect(text).not.toContain('INSUFFICIENT')
  })
  test('the real setting is named beside the simulated one, as it is', () => {
    const cfg = cfgOf()
    const c = calibrationOf([item(occ(1))], cfg)
    expect(calibrationText(c, cfg, { enabled: false, recording: true })).toContain('guardAlerts is off (recording only) and was not changed')
    expect(calibrationText(c, cfg, { enabled: false, recording: false })).toContain('guardAlerts is off and was not changed')
    expect(calibrationText(c, cfg, { enabled: true, recording: false })).toContain('guardAlerts is on and was not changed')
  })
  test('deferred incidents are a row of their own that says what was not simulated', () => {
    const cfg = cfgOf(QUIET)
    const text = calibrationText(calibrationOf([item(occ(1, 'run-blocked', IN), 'NOTIFY'), item(occ(2, 'review-hold', IN), 'NOISE')], cfg), cfg, REAL)
    expect(text).toContain('  deferred for quiet hours: 2 (wanted 1 · not wanted 1) · in neither rate; whether one was told afterwards is not simulated')
    expect(text).toContain('0 not notified of 0 reviewed incidents labelled NOTIFY')
  })
  test('unreadable labels are counted as unreviewed and said', () => {
    const cfg = cfgOf()
    expect(calibrationText(calibrationOf([item(occ(1), null, true)], cfg), cfg, REAL)).toContain('1 stored label could not be read and is counted here.')
    expect(calibrationText(calibrationOf([item(occ(1), null, true), item(occ(2), null, true)], cfg), cfg, REAL)).toContain('2 stored labels could not be read and are counted here.')
  })
  test('the simulated policy is described from the frozen copy, problems included', () => {
    expect(policyText(cfgOf())).toEqual(['  notified kinds: all five (guardNotifyKinds)', '  quiet hours: off (guardQuietHours)'])
    expect(policyText(cfgOf({ guardNotifyKinds: 'bogus' })).some(l => l.startsWith('  WARN guardNotifyKinds'))).toBe(true)
    const broken = policyText(cfgOf({ guardQuietHours: 'nonsense' }))
    expect(broken).toContain('  quiet hours: NOT IN FORCE, the settings were not understood, so nothing is deferred')
    expect(broken.some(l => l.startsWith('  WARN guardQuietHours'))).toBe(true)
    expect(policyText(cfgOf({ guardNotifyKinds: 'none', ...QUIET }))).toEqual([
      '  notified kinds: security-failure · NOT notified: release-no-go, verification-exhausted, review-hold, run-blocked (guardNotifyKinds)',
      '  quiet hours: 00:00-00:30 UTC (guardQuietTimezone) · in the window ordinary alerts are deferred and critical alerts are sent',
    ])
  })
  test('sweep: never "recall", never advice, never "delivered", always what was not simulated, and no id from a record', () => {
    const next = lcg(5)
    const pick = pickOf(next)
    for (let n = 0; n < 120; n++) {
      const list: Reviewed[] = []
      for (let i = 0, m = Math.floor(next() * 30); i < m; i++) list.push(item(occ(i + 1, pick(KINDS), Math.floor(next() * 86_400_000)), next() < 0.3 ? null : pick(LABELS)))
      const cfg = cfgOf({ guardNotifyKinds: pick(['', 'none', 'review-hold']), guardQuietHours: pick(['', '20:00-08:00']), guardQuietTimezone: 'UTC' })
      const c = calibrationOf(list, cfg)
      const text = calibrationText(c, cfg, { enabled: next() < 0.5, recording: next() < 0.5 })
      expect(text).not.toMatch(/\brecall\b/i)
      expect(text).not.toMatch(/\b(recommend|suggest|should|consider|advis)/i)
      expect(text).not.toMatch(/delivered/i)
      expect(text.replaceAll('cannot be turned off', '')).not.toMatch(/turn(ed)? (it |them )?off|disabl|switch(ed)? off/i)
      expect(text).toContain('nothing sent')
      if (c.recorded > 0) expect(text).toContain(NOT_SIMULATED)
      for (const line of text.split('\n').filter(l => l.includes('%'))) expect(line).toContain(' of ')
      for (const x of list) expect(text).not.toContain(x.occurrence.id)
      expect(text.includes('security-failure is critical')).toBe(c.byKind.some(k => k.kind === 'security-failure'))
    }
  })
})

describe('the review list', () => {
  test('unreviewed first, the gravest kind first, then the latest recorded', () => {
    const labelled = item(occ(1, 'security-failure', 9000), 'NOISE')
    const oldSecurity = item(occ(2, 'security-failure', 1000))
    const newSecurity = item(occ(3, 'security-failure', 5000))
    const review = item(occ(4, 'review-hold', 8000))
    const blocked = item(occ(5, 'run-blocked', 9500))
    expect(reviewOrder([labelled, blocked, oldSecurity, review, newSecurity]).map(x => x.occurrence.id)).toEqual([newSecurity, oldSecurity, review, blocked, labelled].map(x => x.occurrence.id))
    expect(PRIORITY[0]).toBe('security-failure')
  })
  test('eight to a page, the page clamped, the next page named', () => {
    const list = Array.from({ length: 20 }, (_, i) => item(occ(i + 1, 'run-blocked', 100_000 - i)))
    const ids = (text: string) => text.split('\n').filter(l => /^ {2}[0-9a-f]{8} /.test(l)).map(l => l.slice(2, 10))
    const order = reviewOrder(list).map(x => x.occurrence.id)
    expect(ids(reviewText(list, 1, IN, NONE))).toEqual(order.slice(0, 8))
    expect(ids(reviewText(list, 2, IN, NONE))).toEqual(order.slice(8, 16))
    expect(ids(reviewText(list, 3, IN, NONE))).toEqual(order.slice(16))
    expect(reviewText(list, 1, IN, NONE)).toContain('More: /cockpit alerts review 2')
    expect(reviewText(list, 3, IN, NONE)).toContain('More: /cockpit alerts review 1')
    expect(reviewText(list, 0, IN, NONE)).toContain('page 1 of 3')
    expect(reviewText(list, 99, IN, NONE)).toContain('page 3 of 3')
  })
  test('a label is shown with its occurrence, and a label that cannot be read is said to be so', () => {
    const text = reviewText([item(occ(1), 'NOISE'), item(occ(2), null, true), item(occ(3))], 1, IN, NONE)
    const lines = text.split('\n')
    expect(lines).toContain('REVIEWED (your label)')
    expect(lines).toContain('UNREVIEWED (no notification preference recorded)')
    expect(lines.find(l => l.includes(occ(1).id))!.endsWith(' · labelled NOISE')).toBe(true)
    expect(lines.find(l => l.includes(occ(2).id))!.endsWith(' · its stored label could not be read')).toBe(true)
    expect(lines.indexOf('UNREVIEWED (no notification preference recorded)')).toBeLessThan(lines.indexOf('REVIEWED (your label)'))
  })
  test('the fields the inbox shows and nothing else: no condition key, and the standing as this session can vouch for it', () => {
    const list = [item(occ(1, 'run-blocked')), item(occ(2, 'review-hold'))]
    const unknown = reviewText(list, 1, IN + 10, NONE)
    for (const x of list) expect(unknown).not.toContain(x.occurrence.key)
    expect(unknown).toContain(`${occ(1).id} NORMAL run-blocked · task 1 · recorded 1970-01-01 00:16Z (just now) · not acknowledged · condition state UNKNOWN from this session`)
    expect(reviewText(list, 1, IN + 10, { uid: '1@1', blind: [] })).toContain(`${occ(1).id} NORMAL run-blocked · task 1 · recorded 1970-01-01 00:16Z (just now) · not acknowledged · condition no longer open (observed not holding)`)
  })
  test('it says it is not a look, and how to label', () => {
    const text = reviewText([item(occ(1))], 1, IN, NONE)
    expect(text).toContain('This list is not a look: SINCE LAST LOOK is unchanged.')
    expect(text).toContain('Label one: /cockpit alerts label <id> notify|record|noise|clear')
  })
  test('with nothing recorded it says so', () => {
    const text = reviewText([], 1, IN, NONE)
    expect(text.split('\n')[0]).toBe('ALERT REVIEW · 0 recorded · 0 reviewed · 0 unreviewed · page 1 of 1')
    expect(text).toContain('Nothing recorded.')
  })
})
