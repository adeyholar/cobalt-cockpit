// v0.6.2 Persistent Attention: acknowledged incidents whose condition is still demonstrably open, in the digest.
// An acknowledgment, a look and a resolution are three facts. OPEN is read off this session's current task and never off a record;
// a condition this session cannot observe is UNKNOWN, which is not resolved. Synthetic: nothing here shows that a person saw anything.

import { describe, expect, test } from 'claude-code/testing'
import { DETAIL_OF, dueOf, ATTENTION_DETAIL_MAX, ALERT_CAP, ackKeyOf, KINDS, attentionLines, attentionOf, bounded, decide, deferredOf, digestText, isSettledQuietly, episodesOf, guardConfigOf, hudCountsOf, inboxOrder, isAlertRecord, occKeyOf, occurrencesOf, pinLine, remind, standingOf, validAlerts } from '../hooks/alerts'
import type { AlertKind, AlertRecord, Observation, Occurrence } from '../hooks/alerts'
import { applyAction, newTask, settle } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { FIVE, hostState, mountHud, planAndComplete, progress, rowsOf, start, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const NEVER_CLAIMED = /\b(seen by|unseen|heard|delivered|read by|missed|silent(ly)?|disconnect(ed)?|reconnect(ed)?)\b/i
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const recorded = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'recorded', attempts: 0, channel: null, ...over })
const resolved = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'resolved', attempts: 0, channel: null, ...over })
const written = (...rs: AlertRecord[]): AlertRecord[] => rs.reduce<AlertRecord[]>((all, r) => bounded(all, r), [])
const idsOf = (kept: readonly AlertRecord[]): string[] => episodesOf(kept).map(e => e.id)
const K = (uid: string, kind: AlertKind, detail: string) => `${uid}:${kind}:${detail}`
const DETAIL: Record<AlertKind, string> = { 'security-failure': 'SECURITY', 'release-no-go': 'release', 'verification-exhausted': 'TEST', 'review-hold': 'review', 'run-blocked': 'task' }
const keyOf = (uid: string, kind: AlertKind) => K(uid, kind, DETAIL[kind])
const OBS: Observation = { uid: '1@100', blind: [] }
const NOBODY: Observation = { uid: null, blind: [] }
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const say = async ($: any, args: string, columns = 120) => String((await $.command.run({ command: 'cockpit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns } } as never) as { text?: string }).text)
const block = ($: any) => progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
const unblock = ($: any) => progress($, { action: 'unblock', milestone: 'm2' })
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const idOf = (text: string, kind: string): string => new RegExp(`\\b([0-9a-f]{8}) (?:CRITICAL|HIGH|NORMAL) ${kind}\\b`).exec(text)?.[1] ?? 'none'
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const guardRow = async ($: any, columns = 120) => (await rowsOf(await mountHud($, 'terminal', columns))).find(r => r.includes('GUARD') || r.includes('▲'))
const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const REC = (extra: Record<string, unknown> = {}) => ({ options: { guardRecordOnly: true, guardCooldownSec: 30, ...extra } })
const ALERTS = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20, ...extra } })
const attention = (text: string): string => text.slice(text.indexOf('COBALT GUARD / ATTENTION'))
const countOf = (text: string, label: string): number => Number(new RegExp(`^${label}: (\\d+)`, 'm').exec(text)?.[1] ?? NaN)
const blockedTask = (): Task => {
  let t = newTask(1, 'goal', 100, null)
  t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

  return settle(applyAction(t, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
}
const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:run-blocked:task`
/** A small deterministic generator, so the sweeps are reproducible. */
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
const history = (next: () => number): { records: AlertRecord[]; open: { kind: AlertKind; key: string }[] } => {
  const uids = ['1@100', '2@200', '3@300']
  let kept: AlertRecord[] = []
  for (let i = 0, n = 1 + Math.floor(next() * 14); i < n; i++) {
    const kind = KINDS[Math.floor(next() * KINDS.length)] as AlertKind
    const key = keyOf(uids[Math.floor(next() * uids.length)] as string, kind)
    const outcome = (['sent', 'recorded', 'resolved', 'deferred', 'failed', 'silenced'] as const)[Math.floor(next() * 6)] as AlertRecord['outcome']
    kept = bounded(kept, rec(key, { kind, at: 1000 + i, outcome, ...(next() < 0.4 ? { acked: true as const } : {}) }))
  }
  const open = KINDS.filter(() => next() < 0.3).map(kind => ({ kind, key: keyOf('1@100', kind) }))

  return { records: kept, open }
}

describe('standing: what this session can vouch for', () => {
  const occ = (records: AlertRecord[], open: { kind: AlertKind; key: string }[] = []): Occurrence => occurrencesOf(records, open)[0] as Occurrence
  test('OPEN only where the key is in the open set of this session\'s own task', () => {
    const k = keyOfTask(blockedTask())
    expect(standingOf(occ(written(rec(k)), [{ kind: 'run-blocked', key: k }]), { uid: '1@100', blind: [] })).toBe('OPEN')
  })
  test('a record that was once open is not open: no open set, no OPEN', () => {
    const o = occ(written(rec(keyOf('1@100', 'security-failure'), { kind: 'security-failure' })))
    expect(o.state).toBe('ended')
    expect(standingOf(o, OBS)).toBe('CLEARED')
    expect(standingOf(o, NOBODY)).toBe('UNKNOWN')
  })
  test('another session\'s or an earlier task\'s incident is UNKNOWN, never CLEARED or RESOLVED', () => {
    const o = occ(written(rec(keyOf('2@200', 'review-hold'), { kind: 'review-hold' })))
    expect(standingOf(o, OBS)).toBe('UNKNOWN')
  })
  test('a uid that merely starts the same does not match', () => {
    const o = occ(written(rec(keyOf('1@1000', 'run-blocked'))))
    expect(standingOf(o, { uid: '1@100', blind: [] })).toBe('UNKNOWN')
    expect(standingOf(o, { uid: '1@10', blind: [] })).toBe('UNKNOWN')
  })
  test('a recorded resolution is RESOLVED, whoever raised it', () => {
    const k = keyOf('2@200', 'run-blocked')
    expect(standingOf(occ(written(rec(k), resolved(k))), OBS)).toBe('RESOLVED')
  })
  test('a kind this session could not read is UNKNOWN even for its own task, open or not', () => {
    const k = keyOf('1@100', 'release-no-go')
    const blind: Observation = { uid: '1@100', blind: ['release-no-go'] }
    expect(standingOf(occ(written(rec(k, { kind: 'release-no-go' }))), blind)).toBe('UNKNOWN')
    expect(standingOf(occ(written(rec(k, { kind: 'release-no-go' })), [{ kind: 'release-no-go', key: k }]), blind)).toBe('UNKNOWN')
  })
  test('sweep: nothing is OPEN without an open entry for its own task, and UNKNOWN is never CLEARED or RESOLVED', () => {
    const next = lcg(20260713)
    for (let n = 0; n < 400; n++) {
      const { records, open } = history(next)
      for (const o of occurrencesOf(records, [])) expect(standingOf(o, OBS)).not.toBe('OPEN')
      for (const o of occurrencesOf(records, open)) {
        const s = standingOf(o, OBS)
        if (s === 'OPEN') expect(open.some(x => x.key === o.key) && o.key.startsWith('1@100:')).toBe(true)
        if (o.state === 'ended' && !o.key.startsWith('1@100:')) expect(s).toBe('UNKNOWN')
        expect(standingOf(o, NOBODY) === 'OPEN' || standingOf(o, NOBODY) === 'CLEARED').toBe(false)
      }
    }
  })
})

describe('the Attention section', () => {
  const at = 10 * HOUR
  const open1 = keyOf('1@100', 'review-hold')
  const mixed = (): Occurrence[] => {
    const kept = written(
      rec(open1, { kind: 'review-hold', acked: true }),
      rec(keyOf('2@200', 'run-blocked'), { acked: true, at: 2000 }),
      rec(keyOf('1@100', 'run-blocked'), { at: 3000 }),
      rec(keyOf('2@200', 'security-failure'), { kind: 'security-failure', at: 4000 }),
      rec(keyOf('3@300', 'release-no-go'), { kind: 'release-no-go', at: 5000, acked: true }),
      resolved(keyOf('3@300', 'release-no-go'), { kind: 'release-no-go', at: 6000 }),
    )

    return occurrencesOf(kept, [{ kind: 'review-hold', key: open1 }])
  }
  test('shows acknowledged-and-open and acknowledged-and-unknown, independently of the unacknowledged ones', () => {
    const text = attentionLines(mixed(), OBS, new Set(), at).join('\n')
    expect(text).toContain('COBALT GUARD / ATTENTION')
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
    expect(text).toContain('- HIGH: 1 review hold')
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(1)
    expect(text).toContain('- NORMAL: 1 blocked run')
    expect(text).toContain('UNKNOWN is not resolved')
    expect(countOf(text, 'ACKNOWLEDGED, NO LONGER OPEN')).toBe(1)
  })
  test('every occurrence is counted in exactly one group (sweep)', () => {
    const next = lcg(77)
    for (let n = 0; n < 400; n++) {
      const { records, open } = history(next)
      const occ = occurrencesOf(records, open)
      for (const seen of [undefined, null, new Set(occ.slice(0, 2).map(o => o.id))] as const) {
        const g = attentionOf(occ, OBS, seen)
        const all = [...g.fresh, ...g.waiting, ...g.stillOpen, ...g.unverified, ...g.closed].map(o => o.id)
        expect(all.length).toBe(occ.length)
        expect(new Set(all).size).toBe(occ.length)
        expect(g.stillOpen.every(o => o.acked && standingOf(o, OBS) === 'OPEN')).toBe(true)
        expect(g.unverified.every(o => o.acked && standingOf(o, OBS) === 'UNKNOWN')).toBe(true)
      }
    }
  })
  test('new incidents are counted by identity, apart from the acknowledged ones', () => {
    const occ = mixed()
    const first = attentionLines(occ, OBS, null, at).join('\n')
    expect(countOf(first, 'NEW SINCE LAST LOOK')).toBe(2)
    expect(first).toContain('(no earlier look)')
    const all = attentionLines(occ, OBS, new Set(occ.map(o => o.id)), at).join('\n')
    expect(countOf(all, 'NEW SINCE LAST LOOK')).toBe(0)
    expect(countOf(all, 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
    expect(attentionLines(occ, OBS, undefined, at).join('\n')).toContain('NEW SINCE LAST LOOK: not tracked here')
  })
  test('a bound: counts are complete, details are capped, and the rest is said', () => {
    const many = Array.from({ length: 9 }, (_, i) => rec(keyOf(`${i + 10}@9`, 'run-blocked'), { acked: true, at: 1000 + i }))
    const lines = attentionLines(occurrencesOf(written(...many), []), OBS, new Set(), at)
    const text = lines.join('\n')
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(9)
    expect(text).toContain('- NORMAL: 9 blocked runs')
    expect(lines.filter(l => /^ {2}[0-9a-f]{8} /.test(l))).toHaveLength(ATTENTION_DETAIL_MAX)
    expect(text).toContain(`+${9 - ATTENTION_DETAIL_MAX} more: /cockpit alerts`)
  })
  test('narrow terminals: no line is wider than the width, and the closed vocabulary holds', () => {
    for (const columns of [120, 80, 60, 40, 24]) for (const line of attentionLines(mixed(), OBS, null, at, columns)) expect(line.length).toBeLessThanOrEqual(columns)
    expect(attentionLines(mixed(), OBS, null, at).join('\n')).not.toMatch(NEVER_CLAIMED)
  })
  test('narrow widths keep the words that keep a line honest', () => {
    for (const columns of [24, 40, 60]) {
      const text = attentionLines(mixed(), OBS, null, at, columns).join('\n')
      expect(text).toMatch(/unacked|unacknowledged only/)
      expect(text).toMatch(/UNKNOWN (is not resolved|≠ resolved)/)
      expect(text).toMatch(/Ack|Acknowledging/)
    }
    for (const columns of [1, 2, 5]) for (const line of attentionLines(mixed(), OBS, null, at, columns)) expect(line.length).toBeLessThanOrEqual(columns)
  })
  test('the since-last-look summary does not call an unobservable condition history', () => {
    const occ = occurrencesOf(written(rec(keyOf('2@200', 'run-blocked')), rec(keyOf('1@100', 'security-failure'), { kind: 'security-failure', at: 2 })), [])
    const text = digestText(occ, at, true, { seen: null, observation: OBS })
    expect(text).toMatch(/history 1 · state UNKNOWN 1/)
    expect(digestText(occ, at, true, { seen: null })).toMatch(/history 2/)
  })
  test('the digest carries the section, and without an observation it reads as it did', () => {
    const occ = mixed()
    expect(digestText(occ, at, true, { seen: null, observation: OBS })).toContain('COBALT GUARD / ATTENTION')
    expect(digestText(occ, at, true, { seen: null })).not.toContain('COBALT GUARD')
    expect(digestText(occ, at, true)).toBe(digestText(occ, at, true, { recording: false }))
  })
  test('the unacknowledged history line separates UNKNOWN from no longer open', () => {
    const occ = occurrencesOf(written(rec(keyOf('2@200', 'run-blocked')), rec(keyOf('1@100', 'security-failure'), { kind: 'security-failure' })), [])
    const text = digestText(occ, at, true, { observation: OBS })
    expect(text).toContain('Condition open now: 0 · no longer open (history): 1 · state UNKNOWN from this session: 1')
  })
  test('an acknowledged incident with nothing else recorded still gets its section', () => {
    const occ = occurrencesOf(written(rec(open1, { kind: 'review-hold', acked: true })), [{ kind: 'review-hold', key: open1 }])
    const text = digestText(occ, at, true, { observation: OBS, seen: new Set() })
    expect(text).toContain('nothing unacknowledged of 1 recorded')
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
  })
  test('malformed and older histories: nothing is believed, nothing throws', () => {
    const junk = [null, 7, 'x', [], {}, { key: 1 }, rec('1@100:run-blocked:task', { kind: 'nope' as AlertKind }), { ...rec('1@100:run-blocked:task'), acked: 'yes' }, { ...rec('1@100:run-blocked:task'), outcome: 'open' }]
    expect(validAlerts(junk)).toEqual([])
    const old = { key: '1@100:run-blocked:task', kind: 'run-blocked', taskId: 1, at: 1, outcome: 'sent', attempts: 1, channel: null }
    expect(isAlertRecord(old)).toBe(true)
    const occ = occurrencesOf(validAlerts([...junk, old]), [])
    expect(occ).toHaveLength(1)
    expect(standingOf(occ[0] as Occurrence, OBS)).toBe('CLEARED')
    expect(() => attentionLines(occ, OBS, undefined, 5)).not.toThrow()
    expect(() => attentionLines([], OBS, null, 5)).not.toThrow()
  })
  test('the history stays within its existing cap however it is read', () => {
    const next = lcg(5)
    let kept: AlertRecord[] = []
    for (let i = 0; i < ALERT_CAP * 3; i++) kept = bounded(kept, rec(keyOf(`${Math.floor(next() * 50)}@1`, 'run-blocked'), { at: i, ...(next() < 0.5 ? { acked: true as const } : {}) }))
    expect(kept.length).toBeLessThanOrEqual(ALERT_CAP)
    expect(() => attentionLines(occurrencesOf(kept, []), OBS, null, 1)).not.toThrow()
  })
  test('unknown ranks above history in the inbox, and the old order holds without an observation', () => {
    const occ = occurrencesOf(written(rec(keyOf('1@100', 'run-blocked'), { at: 1 }), rec(keyOf('2@200', 'run-blocked'), { at: 2 })), [])
    expect(inboxOrder(occ, OBS).map(o => o.key)).toEqual([keyOf('2@200', 'run-blocked'), keyOf('1@100', 'run-blocked')])
    expect(inboxOrder(occ).map(o => o.key)).toEqual(inboxOrder(occ, undefined).map(o => o.key))
  })
})

describe('an acknowledged incident that stays open is never told again (sweep)', () => {
  const cfg = guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 5, guardCooldownSec: 30, guardMaxAlerts: 20 })
  const state = { sentAt: null, count: 0, silenced: [], all: false, pending: false }
  test('no reminder, no new alert, no deferred notice, however long it stays open', () => {
    const next = lcg(9)
    for (let n = 0; n < 300; n++) {
      const key = keyOf('1@100', KINDS[Math.floor(next() * KINDS.length)] as AlertKind)
      const kind = key.split(':')[1] as AlertKind
      const outcomes: AlertRecord['outcome'][] = next() < 0.5 ? ['sent'] : next() < 0.5 ? ['deferred'] : ['recorded']
      const kept = written(...outcomes.map((o, i) => rec(key, { kind, outcome: o, at: 1000 + i, ...(i === outcomes.length - 1 ? { acked: true as const } : {}) })))
      const later = 1000 + Math.floor(next() * 40 * HOUR)
      expect(remind(cfg, state, kept, key, later)).toMatchObject({ send: false })
      // a deferred notice acknowledged before it was told is settled quietly: the caller checks this before it sends
      const d = decide(cfg, state, kept, key, later)
      expect(d.send === false || isSettledQuietly(kept, key)).toBe(true)
      expect(deferredOf(kept)).toEqual([])
    }
  })
})

describe('the HUD row', () => {
  test('the row is what it was when nothing acknowledged is open', () => {
    expect(pinLine([], true, 'ARMED', 120)?.text).toBe('GUARD: ARMED · transport not confirmed · /cockpit guard test')
    expect(pinLine([], false, 'ARMED', 120)).toBeNull()
    expect(pinLine([], false, 'ARMED', 120, 2)?.text).toBe('GUARD: ARMED · 2 unacknowledged in history · /cockpit alerts')
  })
  test('an acknowledged condition still open, and one that cannot be observed, are told apart from history and fit any width', () => {
    expect(pinLine([], false, 'ARMED', 120, 0, { unverified: 0, ackOpen: 2 })?.text).toBe('GUARD: ARMED · 2 acknowledged, still open · /cockpit alerts digest')
    expect(pinLine([], false, 'ARMED', 120, 1, { unverified: 3, ackOpen: 0 })?.text).toBe('GUARD: ARMED · 1 unacknowledged in history · 3 unverified · /cockpit alerts digest')
    for (const width of [120, 60, 40, 30, 20, 12, 6, 1]) {
      const line = pinLine([], true, 'ARMED', width, 4, { unverified: 2, ackOpen: 5 })
      expect(line?.text.length ?? 0).toBeLessThanOrEqual(width)
      expect(line?.level).toBe('INFO')
    }
  })
  test('counts: observed-closed history, unobservable history and acknowledged-open are separate', () => {
    const k = keyOf('1@100', 'review-hold')
    const occ = occurrencesOf(written(rec(k, { kind: 'review-hold', acked: true }), rec(keyOf('1@100', 'security-failure'), { kind: 'security-failure', at: 2 }), rec(keyOf('2@200', 'run-blocked'), { at: 3 })), [{ kind: 'review-hold', key: k }])
    expect(hudCountsOf(occ, OBS)).toEqual({ unread: 1, unverified: 1, ackOpen: 1 })
    expect(hudCountsOf(occ, NOBODY)).toEqual({ unread: 0, unverified: 2, ackOpen: 0 })
  })
})

describe('in a run', () => {
  const stored = async (t: Task, over: Partial<AlertRecord> = {}, foreign: AlertRecord[] = []) => {
    const project = await projectHash('/work/example')
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id, ...over }), ...foreign)

    return { project, records, store: Object.fromEntries(episodesOf(records).map(e => [occKeyOf(project, e.id), { v: 1, records: e.records }])) as Record<string, unknown> }
  }
  test('record-only: acknowledge, and the condition is listed as still open, with nothing sent', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($); await block($)
    const inbox = await say($, 'alerts')
    await say($, `alerts ack ${idOf(inbox, 'security-failure')}`)
    await say($, `alerts ack ${idOf(inbox, 'run-blocked')}`)
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(2)
    expect(text).toContain('- CRITICAL: 1 security failure')
    expect(text).toContain('- NORMAL: 1 blocked run')
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(0)
    expect(w.notified).toEqual([])
    // acknowledging did not clear the hold
    expect(ledger(held).alerts?.every(a => a.outcome === 'recorded' || a.outcome === 'resolved')).toBe(true)
  })
  test('the digest is read-only: no store write, no ledger change, no marker, however often it is drawn', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'run-blocked')}`)
    const before = JSON.stringify(ledger(held))
    const writes = w.storeWrites.length
    for (let i = 0; i < 3; i++) await say($, 'alerts digest')
    expect(JSON.stringify(ledger(held))).toBe(before)
    expect(w.storeWrites.slice(writes)).toEqual([])
    expect(w.notified).toEqual([])
  })
  test('the condition resolves after the acknowledgment: it leaves the open list and is counted as closed', REC(), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'run-blocked')}`)
    expect(countOf(attention(await say($, 'alerts digest')), 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
    await w.clock.advance(MIN)
    await unblock($)
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(0)
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(0)
    expect(countOf(text, 'ACKNOWLEDGED, NO LONGER OPEN')).toBe(1)
  })
  test('the condition recurs: a new occurrence is new, the acknowledged old one stays closed, nothing is told', REC(), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'run-blocked')}`)
    await w.clock.advance(MIN); await unblock($)
    await w.clock.advance(MIN); await block($)
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'NEW SINCE LAST LOOK')).toBe(1)
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(0)
    expect(countOf(text, 'ACKNOWLEDGED, NO LONGER OPEN')).toBe(1)
    expect(w.notified).toEqual([])
  })
  test('another session\'s acknowledged incident is UNVERIFIED here, in the digest and on the HUD, and never resolved', ALERTS(), async ($, on) => {
    const { store } = await stored(blockedTask(), { outcome: 'sent', attempts: 1, channel: 'kitty', acked: true }, [])
    const w = world(on, {}, store); hostState(on, {}); session(on, 's2')
    await start($)
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(1)
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(0)
    expect(text).toContain('UNKNOWN is not resolved')
    expect(text).not.toContain('NO LONGER OPEN')
    expect(await guardRow($)).toContain('GUARD: ARMED')
    await w.clock.advance(5 * HOUR)
    expect(w.notified).toEqual([])
  })
  test('alerts disabled with existing history: the section is drawn from what was recorded, and nothing new is recorded or sent', { options: {} }, async ($, on) => {
    const { store } = await stored(blockedTask(), { acked: true })
    const w = world(on, {}, store); const held = hostState(on, {}); session(on, 's2')
    await start($)
    const text = await say($, 'alerts digest')
    expect(countOf(attention(text), 'UNVERIFIED CONDITION STATE')).toBe(1)
    expect(text).toContain('Alerts are off (guardAlerts)')
    expect(w.notified).toEqual([])
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-'))).toEqual([])
    expect(ledger(held).alerts ?? []).toHaveLength(1)
    expect((ledger(held).alerts ?? []).every(a => a.outcome === 'recorded')).toBe(true)
  })
  test('the same task after a restart: its acknowledged condition is observed open again, and is not told again', ALERTS({ guardRepeat: true, guardRepeatSec: 60 }), async ($, on) => {
    const t = blockedTask()
    const { store } = await stored(t, { outcome: 'sent', attempts: 1, channel: 'kitty', acked: true })
    const w = world(on, {}, store); hostState(on, { task: t }); session(on, 's9')
    await start($)
    await w.clock.advance(6 * HOUR)
    expect(w.notified).toEqual([])
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(0)
    expect(await guardRow($)).toContain('1 acknowledged, still open')
  })
  test('quiet hours and reminders: an acknowledged open incident causes no notification however long it lasts', ALERTS({ guardRepeat: true, guardRepeatSec: 60, guardQuietHours: '00:00-23:59' }), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, 'guard ack')
    const sent = w.notified.length
    for (let i = 0; i < 8; i++) { await w.clock.advance(HOUR); await say($, 'alerts digest') }
    expect(w.notified.length).toBe(sent)
    expect(countOf(attention(await say($, 'alerts digest')), 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
  })
  test('concurrent acknowledgment in another session is picked up before the digest is drawn', REC(), async ($, on) => {
    const t = blockedTask()
    const { project, records, store } = await stored(t)
    const id = idsOf(records)[0] as string
    const w = world(on, {}, store); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(countOf(attention(await say($, 'alerts digest')), 'STILL OPEN, ACKNOWLEDGED')).toBe(0)
    // the other session acknowledges: one key of its own, set in one step
    w.store.set(ackKeyOf(project, id), { v: 1 })
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'STILL OPEN, ACKNOWLEDGED')).toBe(1)
    expect(countOf(text, 'NEW SINCE LAST LOOK')).toBe(0)
    expect(w.notified).toEqual([])
  })
  test('the inbox shows the same standing, and looking at it acknowledges and resolves nothing', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'run-blocked')}`)
    const before = JSON.stringify(ledger(held).alerts)
    const inbox = await say($, 'alerts')
    expect(inbox).toMatch(/acknowledged · condition OPEN now/)
    expect(JSON.stringify(ledger(held).alerts)).toBe(before)
    expect(w.notified).toEqual([])
  })
  test('another session\'s pass never records this session\'s unobservable incident resolved: it stays UNKNOWN', ALERTS(), async ($, on) => {
    const { store } = await stored(blockedTask(), { outcome: 'sent', attempts: 1, channel: 'kitty', acked: true })
    const w = world(on, {}, store); const held = hostState(on, {}); session(on, 's2')
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(HOUR)
    // this session owns its own task only; the older acknowledged incident is not its to close
    expect((ledger(held).alerts ?? []).filter(a => a.outcome === 'resolved')).toEqual([])
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(1)
    expect(text).not.toContain('NO LONGER OPEN')
  })
  test('acknowledging an incident this session cannot observe does not claim its condition no longer holds', REC(), async ($, on) => {
    const { records, store } = await stored(blockedTask())
    world(on, {}, store); hostState(on, {}); session(on, 's2')
    await start($)
    const text = await say($, `alerts ack ${idsOf(records)[0]}`)
    expect(text).toContain('cannot be observed from this session')
    expect(text).not.toContain('no longer holds')
  })
  test('an unreadable release history makes a recorded NO-GO UNKNOWN, never cleared', ALERTS(), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const key = `${t.id}@${t.startedAt}:release-no-go:release`
    const records = written(rec(key, { kind: 'release-no-go', at: 1, taskId: t.id, acked: true }))
    const store: Record<string, unknown> = { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records }, 'release-reviews': { not: 'a list' } }
    world(on, {}, store); hostState(on, { task: t }); session(on, 's2')
    await start($)
    const text = attention(await say($, 'alerts digest'))
    expect(countOf(text, 'UNVERIFIED CONDITION STATE')).toBe(1)
    expect(text).not.toContain('NO LONGER OPEN')
  })
  test('every kind\'s key is the one dueOf builds, so ownership is matched exactly', () => {
    const f = { taskUid: '4@9', securityFailed: true, stopBlocker: 'check exit 1', blocker: 'b', releaseNoGo: true, reviewOpen: true, atStop: true }
    for (const d of [...dueOf(f), ...dueOf({ ...f, stopBlocker: null })]) expect(d.key).toBe(`4@9:${d.kind}:${DETAIL_OF[d.kind]}`)
    expect(new Set([...dueOf(f), ...dueOf({ ...f, stopBlocker: null })].map(d => d.kind)).size).toBe(KINDS.length)
  })
  describe('a release NO-GO that cannot be observed', () => {
    const REPEAT = ALERTS({ guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 5 })
    /**
     * Counts the reads of the release records (every alert pass and every timer-armed look makes one, so a polling timer would raise
     * it): the stored value is not a list, and a getter on it runs each time the world copies it for a read.
     */
    const counting = (w: { store: Map<string, unknown> }): { reads: () => number } => {
      let n = 0
      w.store.set('release-reviews', { get not() { n++; return 'a list' } })

      return { reads: () => n }
    }
    const seed = async (key: string, taskId: number, extra: Partial<AlertRecord> = {}) => {
      const project = await projectHash('/work/example')
      const records = written(rec(key, { kind: 'release-no-go', taskId, at: 1, ...extra }))

      return { records, store: { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records }, 'release-reviews': { not: 'a list' } } as Record<string, unknown> }
    }
    test('another session\'s NO-GO, inspected here: no timer, no notification, no new occurrence, no resolution', REPEAT, async ($, on) => {
      const { store } = await seed('9@9:release-no-go:release', 9)
      const w = world(on, {}, store); const held = hostState(on, {}); session(on, 's2')
      const c = counting(w)
      await start($)
      const before = JSON.stringify(ledger(held).alerts)
      await say($, 'alerts'); await say($, 'alerts digest'); await say($, 'guard')
      const reads = c.reads()
      // the instrument works: the inspection above did read the release records
      expect(reads).toBeGreaterThan(0)
      await w.clock.advance(6 * HOUR)
      expect(w.notified).toEqual([])
      expect(JSON.stringify(ledger(held).alerts)).toBe(before)
      expect(episodesOf(ledger(held).alerts ?? [])).toHaveLength(1)
      expect(w.storeWrites.filter(x => x.key.startsWith('alert-') && !x.key.startsWith('alert-seen:'))).toEqual([])
      // a timer that polls would read the release records again at each look
      expect(c.reads()).toBe(reads)
      expect(attention(await say($, 'alerts digest'))).not.toContain('NO LONGER OPEN')
    })
    test('this session\'s own NO-GO with an unreadable release history: not closed, not repeated, no timer', REPEAT, async ($, on) => {
      const t = blockedTask()
      const { store } = await seed(`${t.id}@${t.startedAt}:release-no-go:release`, t.id, { outcome: 'sent', attempts: 1, channel: 'kitty' })
      const w = world(on, {}, store); const held = hostState(on, { task: t }); session(on, 's2')
      const c = counting(w)
      await start($)
      await say($, 'alerts digest')
      const before = JSON.stringify(ledger(held).alerts)
      const reads = c.reads()
      // the instrument works: the inspection above did read the release records
      expect(reads).toBeGreaterThan(0)
      await w.clock.advance(6 * HOUR)
      expect(w.notified).toEqual([])
      expect(JSON.stringify(ledger(held).alerts)).toBe(before)
      expect((ledger(held).alerts ?? []).some(a => a.outcome === 'resolved')).toBe(false)
      expect(c.reads()).toBe(reads)
      const text = attention(await say($, 'alerts digest'))
      expect(text).not.toContain('NO LONGER OPEN')
      expect(text).toContain('open now 0 · UNKNOWN 1')
    })
  })
})
