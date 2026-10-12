// v0.5.8: acknowledgments as keys of their own (one atomic store.set each, never read back and rewritten), per-project history
// keys, the history merge, and the return digest. The host's store has no compare-and-set: these tests show what the design
// guarantees by construction and against interleavings built by hand; they do not show cross-process atomicity, which only
// the host provides. Synthetic: nothing here shows that a person saw, heard or was spared anything.

import { describe, expect, test } from 'claude-code/testing'
import { ACK_KEYS_MAX, ACK_PREFIX, ALERT_CAP, OCC_PER_PROJECT, OCC_PROJECTS_MAX, ackKeyOf, ackedIdsOf, applyAcks, bounded, digestOf2, digestText, digestToast, episodesOf, excessAckKeys, excessOccKeys, historyFrom, historyKeyOf, markedIdsOf, occIdsOf, occKeyOf, occurrencesOf, pendingIdsOf } from '../hooks/alerts'
import type { AlertKind, AlertRecord, Open } from '../hooks/alerts'
import { applyAction, newTask, settle } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { FIVE, command, hostState, planAndComplete, progress, start, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const P1 = 'a'.repeat(12)
const P2 = 'b'.repeat(12)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const written = (...rs: AlertRecord[]): AlertRecord[] => rs.reduce<AlertRecord[]>((all, r) => bounded(all, r), [])
const idsOf = (kept: readonly AlertRecord[]): string[] => episodesOf(kept).map(e => e.id)
const ackedOf = (kept: readonly AlertRecord[]): string[] => markedIdsOf(kept).sort()
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const say = async ($: any, args: string) => String((await command($, args)).text)
const block = ($: any) => progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const idOf = (text: string, kind: string): string => new RegExp(`\\b([0-9a-f]{8}) (?:CRITICAL|HIGH|NORMAL) ${kind}\\b`).exec(text)?.[1] ?? 'none'
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const armed = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20, ...extra } })
const blockedTask = (): Task => {
  let t = newTask(1, 'goal', 100, null)
  t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

  return settle(applyAction(t, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
}
const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:run-blocked:task`
/** A small deterministic generator, so the interleavings below are the same on every run. */
const K2 = 'u2:security-failure:SECURITY'
const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }

describe('acknowledgment keys', () => {
  test('a key names a project and an occurrence and nothing else; anything else in the store is ignored', () => {
    const id = '0123abcd'
    expect(ackKeyOf(P1, id)).toBe(`${ACK_PREFIX}${P1}:${id}`)
    const keys = [ackKeyOf(P1, id), ackKeyOf(P2, 'ffffffff'), `${ACK_PREFIX}${P1}:${id}:x`, `${ACK_PREFIX}${P1}`, `${ACK_PREFIX}ZZZZZZZZZZZZ:${id}`, `${ACK_PREFIX}${P1}:0123ABCD`, 'ledger:s1', `x${ACK_PREFIX}${P1}:${id}`, 7, null, undefined, {}]
    expect([...ackedIdsOf(keys, P1)]).toEqual([id])
    expect([...ackedIdsOf(keys, P2)]).toEqual(['ffffffff'])
    expect(ackedIdsOf([], P1).size).toBe(0)
  })
  test('an acknowledgment of one project never marks another project\'s occurrence', () => {
    const kept = written(rec('t1:run-blocked:task'))
    const id = idsOf(kept)[0]!
    expect(markedIdsOf(applyAcks(kept, ackedIdsOf([ackKeyOf(P2, id)], P1)))).toEqual([])
    expect(markedIdsOf(applyAcks(kept, ackedIdsOf([ackKeyOf(P1, id)], P1)))).toEqual([id])
  })
  test('the oldest acknowledgment keys beyond the bound are the ones forgotten, and nothing else is named', () => {
    const keys: string[] = ['ledger:s1']
    for (let i = 0; i < ACK_KEYS_MAX + 5; i++) keys.push(ackKeyOf(P1, i.toString(16).padStart(8, '0')))
    keys.push('alert-history:' + P1)
    const excess = excessAckKeys(keys)
    expect(excess).toHaveLength(5)
    expect(excess).toEqual(keys.filter(k => k.startsWith(ACK_PREFIX)).slice(0, 5))
    expect(excessAckKeys(keys.slice(0, 20))).toEqual([])
  })
  test('occurrence keys: at most four projects, 32 occurrences each, the oldest as the store lists them go, a session\'s own last', () => {
    const projects = ['1', '2', '3', '4', '5', '6'].map(c => c.repeat(12))
    const keys: string[] = ['ledger:s1']
    for (const p of projects) for (let i = 0; i < 3; i++) keys.push(occKeyOf(p, i.toString(16).padStart(8, '0')))
    // the two oldest projects go whole
    expect(excessOccKeys(keys)).toEqual(keys.filter(k => k.includes(':1111') || k.includes(':2222')))
    const many = Array.from({ length: OCC_PER_PROJECT + 3 }, (_, i) => occKeyOf(P1, i.toString(16).padStart(8, '0')))
    expect(excessOccKeys(many)).toEqual(many.slice(0, 3))
    // the session's own are the last to be given up
    expect(excessOccKeys(many, new Set(many.slice(0, 3)))).toEqual(many.slice(3, 6))
    expect(excessOccKeys([...many.slice(0, 5), 'alert-occ:../x', 'alert-occ:' + P1, ackKeyOf(P1, '00000000'), 'alert-history:' + P1])).toEqual([])
    expect(OCC_PROJECTS_MAX).toBe(4)
  })
  test('the writing session\'s own project is never given up at project level, even when its keys are listed first', () => {
    const projects = ['1', '2', '3', '4', '5'].map(c => c.repeat(12))
    const keys = projects.map(p => occKeyOf(p, 'aaaaaaaa'))
    // project 1 is the oldest as listed and is the session's own: the oldest of the others goes instead
    expect(excessOccKeys(keys, new Set(), projects[0])).toEqual([keys[1]])
    expect(excessOccKeys(keys)).toEqual([keys[0]])
    // a fifth project recording does not remove the live one
    expect(excessOccKeys([...keys.slice(0, 4), occKeyOf('6'.repeat(12), 'bbbbbbbb')], new Set(), projects[1])).not.toContain(keys[1])
  })
  test('the ids of a project are read from the keys, in the order listed, and only for that project', () => {
    const keys = [occKeyOf(P1, 'aaaaaaaa'), occKeyOf(P2, 'bbbbbbbb'), occKeyOf(P1, 'cccccccc'), 'alert-occ:' + P1 + ':zzzzzzzz', historyKeyOf(P1)]
    expect(occIdsOf(keys, P1)).toEqual(['aaaaaaaa', 'cccccccc'])
    expect(occIdsOf(keys, P2)).toEqual(['bbbbbbbb'])
  })
})

describe('applying acknowledgments', () => {
  const a = 'u1:run-blocked:task'
  const b = 'u1:security-failure:SECURITY'
  const kept = written(rec(a), rec(b, { kind: 'security-failure', at: 1500 }), rec(a, { at: 2000, nth: 1 }))
  test('only the named occurrences are marked, every record of each, and the input is not touched', () => {
    const [ida, idb] = idsOf(kept)
    const out = applyAcks(kept, new Set([ida!]))
    expect(out.map(r => [r.key, r.acked === true])).toEqual([[a, true], [b, false], [a, true]])
    expect(kept.every(r => r.acked === undefined)).toBe(true)
    expect(idb).toBeDefined()
  })
  test('nothing to apply is the same array, so a caller can tell nothing changed', () => {
    expect(applyAcks(kept, new Set())).toBe(kept)
    expect(applyAcks(kept, new Set(['00000000']))).toBe(kept)
    const done = applyAcks(kept, new Set(idsOf(kept)))
    expect(applyAcks(done, new Set(idsOf(kept)))).toBe(done)
  })
  test('a resolved mark is not itself acknowledged, and a later occurrence of the same condition is not covered', () => {
    const k2 = written(rec(a), rec(a, { outcome: 'resolved', attempts: 0, channel: null, at: 2000 }), rec(a, { at: 3000 }))
    const [old, now] = idsOf(k2)
    const out = applyAcks(k2, new Set([old!]))
    expect(out.map(r => r.acked === true)).toEqual([true, false, false])
    expect(markedIdsOf(out)).toEqual([old])
    expect(now).not.toBe(old)
  })
  test('pending occurrences are the ones with an unacknowledged record that is not a resolved mark', () => {
    const k2 = written(rec(a), rec(a, { outcome: 'resolved', attempts: 0, channel: null, at: 2000 }), rec(b, { kind: 'security-failure', at: 3000 }))
    expect(pendingIdsOf(k2)).toEqual(idsOf(k2))
    expect(pendingIdsOf(applyAcks(k2, new Set(idsOf(k2))))).toEqual([])
  })
})

describe('occurrence keys: stale snapshots, interleaved sessions, conflicting acknowledgments', () => {
  const mk = (n: number, base = 0): AlertRecord[] => written(...Array.from({ length: n }, (_, i) => rec(`t${base + i}:run-blocked:task`, { at: 1000 + base + i, taskId: base + i })))
  /** What a session does with its Ledger: one set per occurrence it changed. */
  const write = (store: Map<string, unknown>, project: string, records: readonly AlertRecord[]): void => {
    for (const e of episodesOf(records)) store.set(occKeyOf(project, e.id), { v: 1, records: e.records })
  }
  const read = (store: Map<string, unknown>, project: string): AlertRecord[] =>
    historyFrom(occIdsOf([...store.keys()], project).map(id => ({ id, records: (store.get(occKeyOf(project, id)) as { records: AlertRecord[] }).records })), [])
  test('two sessions recording different occurrences never lose each other\'s, whatever the order and however stale', () => {
    const store = new Map<string, unknown>()
    const a = mk(3, 0)
    const b = mk(3, 10)
    write(store, P1, a)
    write(store, P1, b)
    write(store, P1, a)
    expect(new Set(episodesOf(read(store, P1)).map(e => e.key))).toEqual(new Set([...a, ...b].map(r => r.key)))
  })
  test('the earlier format\'s records are older than the keys\' and are given up for a key that holds the same occurrence', () => {
    const legacy = mk(2, 0)
    const stored = [{ id: idsOf(legacy)[0]!, records: written(rec('t0:run-blocked:task', { at: 1000, taskId: 0 }), rec('t0:run-blocked:task', { at: 5000, nth: 1, taskId: 0 })) }]
    const out = historyFrom(stored, legacy)
    expect(out.map(r => `${r.key}:${r.nth ?? 0}`)).toEqual(['t1:run-blocked:task:0', 't0:run-blocked:task:0', 't0:run-blocked:task:1'])
    expect(historyFrom([], legacy)).toEqual(legacy)
    expect(historyFrom([{ id: 'aaaaaaaa', records: mk(ALERT_CAP + 5, 0) }], []).length).toBe(ALERT_CAP)
  })
  test('two stored occurrences of one condition, the earlier still open, stay two: the earlier is closed in memory, not merged', () => {
    const k = 'u1:run-blocked:task'
    const first = written(rec(k, { at: 1000 }))
    const second = bounded(bounded(bounded([], rec(k, { at: 3000 })), rec(k, { at: 3500, nth: 1 })), rec(K2, { at: 4000 }))
    const out = historyFrom([{ id: idsOf(first)[0]!, records: first }, { id: idsOf(second)[0]!, records: second.filter(r => r.key === k) }], [])
    const eps = episodesOf(out)
    expect(eps.map(e => e.id)).toEqual([idsOf(first)[0], idsOf(second)[0]])
    expect(eps[0]!.closed).toBe(true)
    expect(eps[1]!.records).toHaveLength(2)
  })
  test('an acknowledgment key is never in the way of a record write, and applies to whichever copy a session assembles', () => {
    const store = new Map<string, unknown>()
    const a = mk(2, 0)
    write(store, P1, a)
    const [first, second] = idsOf(a)
    store.set(ackKeyOf(P1, first!), { v: 1 })
    // a stale session writes its older copy of the same occurrences
    write(store, P1, a)
    const acks = ackedIdsOf([...store.keys()], P1)
    expect([...acks]).toEqual([first])
    expect(ackedOf(applyAcks(read(store, P1), acks))).toEqual([first])
    expect(ackedOf(applyAcks(read(store, P1), acks))).not.toContain(second)
  })
  test('conflicting acknowledgments of different occurrences by two sessions both hold, whatever the order they are applied in', () => {
    const base = mk(4, 0)
    const [w, x, y, z] = idsOf(base)
    const keys = [ackKeyOf(P1, w!), ackKeyOf(P1, x!), ackKeyOf(P1, x!), ackKeyOf(P1, z!)]
    const ab = applyAcks(base, ackedIdsOf(keys, P1))
    const ba = applyAcks(base, ackedIdsOf([...keys].reverse(), P1))
    expect(ackedOf(ab)).toEqual([w, x, z].sort())
    expect(ackedOf(ba)).toEqual(ackedOf(ab))
    expect(ackedOf(ab)).not.toContain(y)
  })
  test('over many interleavings no occurrence one session wrote is lost to the other, and no acknowledgment is ever shown as undone', () => {
    // two sessions with stale copies write their own occurrences into one store; acknowledgment keys only ever appear
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = lcg(seed)
      const store = new Map<string, unknown>()
      let a: AlertRecord[] = []
      let b: AlertRecord[] = []
      const wrote = new Set<string>()
      const acks = new Set<string>()
      let n = 0
      for (let step = 0; step < 24; step++) {
        const r = rnd()
        if (r < 0.3) { a = bounded(a, rec(`a${n}:run-blocked:task`, { at: 2000 + n, taskId: n })); n++ }
        else if (r < 0.55) { b = bounded(b, rec(`b${n}:security-failure:SECURITY`, { kind: 'security-failure', at: 2000 + n, taskId: n })); n++ }
        else if (r < 0.75) { write(store, P1, a); for (const e of episodesOf(a)) wrote.add(e.id) }
        else if (r < 0.9) { write(store, P1, b); for (const e of episodesOf(b)) wrote.add(e.id) }
        else { const ids = occIdsOf([...store.keys()], P1); if (ids.length > 0) { const id = ids[Math.floor(rnd() * ids.length)]!; acks.add(id); store.set(ackKeyOf(P1, id), { v: 1 }) } }
        const seen = new Set(episodesOf(read(store, P1)).map(e => e.id))
        for (const id of wrote) expect(seen.has(id)).toBe(true)
        const marked = new Set(markedIdsOf(applyAcks(read(store, P1), ackedIdsOf([...store.keys()], P1))))
        for (const id of acks) expect(marked.has(id)).toBe(true)
      }
    }
  })
  test('an acknowledgment does not clear the underlying condition: the occurrence stays open and its records stay', () => {
    const k = 'u1:security-failure:SECURITY'
    const kept = written(rec(k, { kind: 'security-failure' }))
    const open: Open[] = [{ key: k, kind: 'security-failure' }]
    const out = applyAcks(kept, new Set(idsOf(kept)))
    const o = occurrencesOf(out, open)[0]!
    expect(o).toMatchObject({ acked: true, state: 'open', level: 'CRITICAL' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ outcome: 'sent', kind: 'security-failure' })
  })
})

describe('the digest', () => {
  const k = (n: number, kind: AlertKind) => `u${n}:${kind}:x`
  const kept = written(
    rec(k(1, 'security-failure'), { kind: 'security-failure', at: 5000, taskId: 1 }),
    rec(k(2, 'review-hold'), { kind: 'review-hold', at: 3000, taskId: 2, outcome: 'deferred', channel: null, attempts: 0, why: 'quiet' }),
    rec(k(3, 'run-blocked'), { at: 4000, taskId: 3, outcome: 'failed', channel: null, why: 'error' }),
    rec(k(4, 'run-blocked'), { at: 6000, taskId: 4, outcome: 'throttled', channel: null, attempts: 0, why: 'budget' }),
    rec(k(5, 'run-blocked'), { at: 7000, taskId: 5 }),
  )
  const acked = applyAcks(kept, new Set([idsOf(kept)[4]!]))
  const open: Open[] = [{ key: k(1, 'security-failure'), kind: 'security-failure' }, { key: k(2, 'review-hold'), kind: 'review-hold' }]
  test('counts the unacknowledged by level, open or historical, and what became of the notification', () => {
    const d = digestOf2(occurrencesOf(acked, open))
    expect(d).toMatchObject({ recorded: 5, unacked: 4, levels: { CRITICAL: 1, HIGH: 1, NORMAL: 2 }, open: 2, history: 2, deferred: 1, notSent: 1, held: 1 })
    expect(d.oldest?.at).toBe(3000)
  })
  test('the text says what was recorded and when the oldest was; it holds no id, key, task identity or path, and never says anything was missed or seen', () => {
    const text = digestText(occurrencesOf(acked, open), 3000 + 3 * HOUR, true)
    expect(text).toContain('4 unacknowledged of 5 recorded')
    expect(text).toContain('By level: CRITICAL 1 · HIGH 1 · NORMAL 2')
    expect(text).toContain('Condition open now: 2 · no longer open (history): 2')
    expect(text).toContain('Notifications: 1 DEFERRED, quiet hours · 1 NOT SENT · 1 HELD BACK, cooldown or budget')
    expect(text).toContain('Oldest unacknowledged: recorded 1970-01-01 00:00Z (3h ago)')
    expect(text).toContain('/cockpit alerts')
    expect(text).not.toMatch(/\b(missed|unseen|heard|delivered|disconnect(ed)?|reconnect(ed)?)\b/i)
    expect(text).not.toMatch(/[0-9a-f]{8} (CRITICAL|HIGH|NORMAL)/)
    expect(text).not.toContain('u1:')
    expect(text.split('\n').length).toBeLessThanOrEqual(8)
  })
  test('empty, all acknowledged, and alerts off', () => {
    expect(digestText([], 0, true)).toContain('nothing recorded.')
    expect(digestText(occurrencesOf(applyAcks(kept, new Set(idsOf(kept))), []), 0, true)).toContain('nothing unacknowledged of 5 recorded.')
    expect(digestText([], 0, false)).toContain('Alerts are off (guardAlerts)')
    expect(digestToast([])).toBeNull()
    expect(digestToast(occurrencesOf(applyAcks(kept, new Set(idsOf(kept))), []))).toBeNull()
  })
  test('the one-line form for the start of a session', () => {
    expect(digestToast(occurrencesOf(acked, open))).toBe('Cobalt alerts: 4 unacknowledged recorded (1 CRITICAL, 1 HIGH, 2 NORMAL) · /cockpit alerts digest')
  })
  test('a long history is bounded: the summary is the same few lines however many records there were', () => {
    let many: AlertRecord[] = []
    for (let i = 0; i < 500; i++) many = bounded(many, rec(`t${i}:run-blocked:task`, { at: 1000 + i, taskId: i }))
    const text = digestText(occurrencesOf(many, []), 1e7, true)
    expect(text.split('\n').length).toBeLessThanOrEqual(8)
    expect(digestOf2(occurrencesOf(many, [])).recorded).toBeLessThanOrEqual(ALERT_CAP)
  })
})

describe('an occurrence\'s only record is the last to go', () => {
  test('a held-back record that is all an open condition has is kept while others can go', () => {
    const only = 'u1:security-failure:SECURITY'
    let kept = written(rec(only, { kind: 'security-failure', outcome: 'throttled', channel: null, attempts: 0, why: 'cooldown' }))
    for (let i = 0; i < 20; i++) {
      const fk = `f${i}:run-blocked:task`
      kept = bounded(bounded(kept, rec(fk, { outcome: 'throttled', channel: null, attempts: 0, why: 'budget', at: 2000 + i })), rec(fk, { at: 3000 + i }))
    }
    expect(kept.length).toBeLessThanOrEqual(ALERT_CAP)
    expect(kept.some(r => r.key === only)).toBe(true)
  })
})

describe('in a run: acknowledgments in the store', () => {
  test('an acknowledgment is one key, written once, with a constant value; the Ledger and the pin agree', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const out = await say($, `alerts ack ${id}`)
    const project = ledger(held).alertsProject!
    expect(out).toContain('It is recorded for this project, so another session reads it too.')
    const writes = w.storeWrites.filter(s => s.key.startsWith(ACK_PREFIX))
    expect(writes).toEqual([{ key: ackKeyOf(project, id), value: { v: 1 } }])
    expect(JSON.stringify(writes)).not.toContain('/work/example')
    expect((ledger(held).alerts ?? []).every(a => a.acked === true)).toBe(true)
  })
  test('an acknowledgment made by another session is found, marks the record, and ends the reminders here', armed({ guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 5 }), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const project = ledger(held).alertsProject!
    // the other session's act, as the store holds it
    w.store.set(ackKeyOf(project, id), { v: 1 })
    await w.clock.advance(31_000)
    await w.clock.advance(5 * MIN)
    expect(w.notified.length).toBe(1)
    expect(await say($, 'alerts')).toMatch(/NORMAL run-blocked .* · acknowledged · condition OPEN now/)
  })
  test('a stale session\'s writes never remove an acknowledgment key', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const project = ledger(held).alertsProject!
    w.store.set(ackKeyOf(project, id), { v: 1 })
    // this session has not looked: it records more and persists several times
    await failSecurity($)
    await w.clock.advance(31_000)
    await progress($, { action: 'status' })
    expect(w.store.get(ackKeyOf(project, id))).toEqual({ v: 1 })
    expect(w.storeWrites.filter(s => s.key === ackKeyOf(project, id))).toEqual([])
    // and the history it wrote shows the occurrence acknowledged
    const wrote = w.storeWrites.filter(s => s.key === occKeyOf(project, id)).at(-1)!.value as { records: AlertRecord[] }
    expect(ackedOf(wrote.records)).toContain(id)
  })
  test('an acknowledgment key for another project, or one that is malformed, marks nothing', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const project = ledger(held).alertsProject!
    for (const key of [ackKeyOf(project === P1 ? P2 : P1, id), `${ACK_PREFIX}${project}:${id.toUpperCase()}`, `${ACK_PREFIX}${project}:${id}:x`, `x${ackKeyOf(project, id)}`]) w.store.set(key, { v: 1 })
    expect(await say($, 'alerts')).toMatch(/NORMAL run-blocked .* · not acknowledged/)
    expect(w.notified.length).toBe(1)
  })
  test('/cockpit guard ack writes a key for each occurrence it acknowledges and none for one that was resolved', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(31_000)
    await failSecurity($)
    await say($, 'guard ack')
    const project = ledger(held).alertsProject!
    const keys = w.storeWrites.filter(s => s.key.startsWith(ACK_PREFIX)).map(s => s.key).sort()
    expect(keys).toEqual(idsOf(ledger(held).alerts ?? []).map(id => ackKeyOf(project, id)).sort())
    expect(keys).toHaveLength(2)
  })
  test('if the key cannot be written the acknowledgment still holds in this session and the person is told it does only there', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    w.failStoreWrites.push(ackKeyOf(ledger(held).alertsProject!, id))
    const out = await say($, `alerts ack ${id}`)
    expect(out).toContain('could not be recorded for the project: it holds in this session only')
    expect(out).toContain('was acknowledged')
    expect((ledger(held).alerts ?? []).every(a => a.acked === true)).toBe(true)
  })
  test('the acknowledgment keys are bounded: the oldest beyond 128 are forgotten', armed(), async ($, on) => {
    const seed: Record<string, unknown> = {}
    for (let i = 0; i < ACK_KEYS_MAX + 10; i++) seed[ackKeyOf(P1, i.toString(16).padStart(8, '0'))] = { v: 1 }
    const w = world(on, {}, seed); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'run-blocked')}`)
    const keys = [...w.store.keys()].filter(k => k.startsWith(ACK_PREFIX))
    expect(keys.length).toBeLessThanOrEqual(ACK_KEYS_MAX)
    expect(keys).toContain(ackKeyOf(ledger(held).alertsProject!, idOf(await say($, 'alerts'), 'run-blocked')))
  })
  test('history written by v0.5.7 under the single key is still read, and never written again', armed(), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const old = written({ ...rec(keyOfTask(t), { at: 1 }), acked: true })
    const w = world(on, {}, { 'alert-history': { v: 1, projects: { [project]: old } } }); hostState(on, { task: t }); session(on, 's7')
    await start($)
    expect(await say($, 'alerts')).toMatch(/NORMAL run-blocked .* · acknowledged · condition OPEN now/)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
    expect(w.storeWrites.some(s => s.key === 'alert-history')).toBe(false)
  })
  test('a restart finds the acknowledgment and sends nothing again', armed({ guardRepeat: true, guardRepeatSec: 60 }), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const past = written(rec(keyOfTask(t), { at: 1 }))
    const w = world(on, {}, { [historyKeyOf(project)]: { v: 1, alerts: past }, [ackKeyOf(project, idsOf(past)[0]!)]: { v: 1 } }); hostState(on, { task: t }); session(on, 's8')
    await start($)
    await w.clock.advance(10 * MIN)
    expect(w.notified).toEqual([])
    expect(await say($, 'alerts')).toMatch(/NORMAL run-blocked .* · acknowledged · condition OPEN now/)
  })
  test('two projects keep separate history keys and neither sees the other\'s', armed(), async ($, on) => {
    const other = written(rec('9@9:run-blocked:task', { at: 5000 }))
    const w = world(on, { cwd: '/work/beta' }, { [historyKeyOf(await projectHash('/work/alpha'))]: { v: 1, alerts: other } }); hostState(on, {}); session(on, 's2')
    await start($)
    expect(await say($, 'alerts')).toContain('Nothing recorded.')
    expect(await say($, 'alerts digest')).toContain('nothing recorded.')
    expect(w.notified).toEqual([])
  })
})

describe('in a run: the inbox and the digest with notifications off', () => {
  const OFF = { options: { guardAlerts: false } }
  const history = async (extra: Record<string, unknown> = {}) => {
    const project = await projectHash('/work/example')
    const t = blockedTask()
    const records = written(rec(keyOfTask(t), { at: 1000, taskId: t.id }), rec('9@9:security-failure:SECURITY', { kind: 'security-failure', taskId: 9, at: 2000 }))

    return { project, t, records, seed: { [historyKeyOf(project)]: { v: 1, alerts: records }, ...extra } }
  }
  test('with guardAlerts off, earlier history is listed, summarised and acknowledged, and nothing new is recorded or sent', OFF, async ($, on) => {
    const { seed, t } = await history()
    const w = world(on, {}, seed); const held = hostState(on, { task: t }); session(on, 's2')
    await start($)
    const list = await say($, 'alerts')
    expect(list).toContain('Alerts are off (guardAlerts)')
    expect(list).toContain('2 recorded')
    expect(await say($, 'alerts digest')).toContain('2 unacknowledged of 2 recorded')
    const before = (ledger(held).alerts ?? []).length
    await say($, `alerts ack ${idOf(list, 'security-failure')}`)
    await planAndComplete($, 1); await block($); await failSecurity($)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
    expect((ledger(held).alerts ?? []).length).toBe(before)
  })
  test('with guardAlerts off and no history, nothing is kept: the ledger gains no project tie and no history key is written', OFF, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($); await failSecurity($)
    expect(ledger(held).alertsProject).toBeUndefined()
    expect(ledger(held).alerts).toBeUndefined()
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-'))).toEqual([])
    expect(await say($, 'alerts digest')).toContain('nothing recorded.')
  })
  test('turning alerts on does not send anything for history that was already there', armed(), async ($, on) => {
    const { seed, t } = await history()
    const w = world(on, {}, seed); hostState(on, { task: t }); session(on, 's2')
    await start($)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
  })
})

describe('in a run: the return digest at the start of a session', () => {
  const ON = (extra: Record<string, unknown> = {}) => ({ options: { guardDigest: true, ...extra } })
  const seedHistory = async (cwd = '/work/example') => {
    const project = await projectHash(cwd)
    const t = blockedTask()
    const records = written(rec(keyOfTask(t), { at: 1000, taskId: t.id }), rec('9@9:security-failure:SECURITY', { kind: 'security-failure', taskId: 9, at: 2000 }))

    return { t, records, seed: { [historyKeyOf(project)]: { v: 1, alerts: records } } as Record<string, unknown> }
  }
  test('off by default: no line, no mark in the store', { options: { guardAlerts: true } }, async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, seed); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual([])
    expect(w.storeWrites.some(s => s.key === 'alert-digest')).toBe(false)
  })
  test('on: one line from the records, in the terminal, once; a reload does not repeat it; no notification, no process, no model call', ON(), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, seed); hostState(on, { task: t }); session(on, 's2')
    await start($); await start($); await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual(['Cobalt alerts: 2 unacknowledged recorded (1 CRITICAL, 1 NORMAL) · /cockpit alerts digest'])
    expect(w.notified).toEqual([])
    expect(w.outbound).toEqual([])
    expect(w.runs.filter(r => !['git', 'realpath', 'readlink', 'stat', 'find', 'tail', 'mkdir', 'chmod', 'rm'].includes(r[0] as string))).toEqual([])
  })
  test('a new session shows it again, and shows nothing when everything is acknowledged', ON(), async ($, on) => {
    const { seed, t, records } = await seedHistory()
    const project = await projectHash('/work/example')
    const acks = Object.fromEntries(idsOf(records).map(id => [ackKeyOf(project, id), { v: 1 }]))
    const w = world(on, {}, { ...seed, ...acks, 'alert-digest': { v: 1, shown: [{ id: 's1', at: 1 }] } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual([])
    // marked, so a later reload with new alerts does not announce them as the session's start
    expect(w.storeWrites.filter(s => s.key === 'alert-digest').at(-1)!.value).toMatchObject({ v: 1, shown: [{ id: 's1', at: 1 }, { id: 's2' }] })
  })
  test('a reload long into the session does not show it again, whatever the marker says', ON(), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, { ...seed, 'alert-digest': { v: 1, shown: [{ id: 's2', at: -3_600_000 }] } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toHaveLength(1)
    await w.clock.advance(2 * HOUR)
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toHaveLength(1)
  })
  test('a marker in the future (a clock stepped back) counts as recent: nothing is shown again', ON(), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, { ...seed, 'alert-digest': { v: 1, shown: [{ id: 's2', at: 9_000_000_000 }] } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual([])
  })
  test('a session already summarised is not summarised again', ON(), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, { ...seed, 'alert-digest': { v: 1, shown: [{ id: 's2', at: 1_000_000 }] } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual([])
  })
  test('a resumed session, back after more than half an hour, is summarised again', ON(), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, { ...seed, 'alert-digest': { v: 1, shown: [{ id: 's2', at: -3_600_000 }] } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toHaveLength(1)
  })
  test('another project\'s history is not summarised, and a damaged marker is ignored', ON(), async ($, on) => {
    const { seed } = await seedHistory('/work/elsewhere')
    const w = world(on, {}, { ...seed, 'alert-digest': 'garbage' }); hostState(on, {}); session(on, 's3')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toEqual([])
  })
  test('works with alerts off, and does not turn them on', ON({ guardAlerts: false }), async ($, on) => {
    const { seed, t } = await seedHistory()
    const w = world(on, {}, seed); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toHaveLength(1)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
  })
  test('/cockpit alerts digest shows the same summary at any time, and takes no argument', { options: { guardAlerts: true } }, async ($, on) => {
    const { seed, t } = await seedHistory()
    world(on, {}, seed); hostState(on, { task: t }); session(on, 's2')
    await start($)
    const text = await say($, 'alerts digest')
    expect(text).toContain('ALERT DIGEST · 2 unacknowledged of 2 recorded')
    expect(text).toContain('By level: CRITICAL 1 · HIGH 0 · NORMAL 1')
    expect(await say($, 'alerts digest now')).toContain('Usage: /cockpit alerts digest')
  })
})

describe('no verdict moved', () => {
  test('acknowledging, syncing and merging change no gate, hold, review, approval or percentage', armed({ guardRepeat: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 2); await failSecurity($)
    const project = ledger(held).alertsProject!
    const task = () => JSON.stringify(held.get('task')!.value)
    const before = task()
    const status = await progress($, { action: 'status' })
    const id = idOf(await say($, 'alerts'), 'security-failure')
    w.store.set(ackKeyOf(project, id), { v: 1 })
    await say($, 'alerts'); await say($, 'alerts digest'); await say($, 'guard ack')
    expect(task()).toBe(before)
    expect(await progress($, { action: 'status' })).toBe(status)
  })
  test('the person-only commands stay person-only', armed(), async ($, on) => {
    world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const out = String((await $.command.run({ command: 'cockpit', args: `alerts ack ${id}`, origin: { kind: 'sdk' }, presentation: { isFullscreen: true, columns: 120 } } as never) as { text?: string }).text)
    expect(out).toContain('only by a command you type')
    expect((ledger(held).alerts ?? []).some(a => a.acked === true)).toBe(false)
  })
})
