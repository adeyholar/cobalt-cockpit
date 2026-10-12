// v0.5.8: acknowledgments as keys of their own (one atomic store.set each, never read back and rewritten), per-project history
// keys, the history merge, and the return digest. The host's store has no compare-and-set: these tests show what the design
// guarantees by construction and against interleavings built by hand; they do not show cross-process atomicity, which only
// the host provides. Synthetic: nothing here shows that a person saw, heard or was spared anything.

import { describe, expect, test } from 'claude-code/testing'
import { ACK_KEYS_MAX, ACK_PREFIX, ALERT_CAP, HISTORY_PROJECTS_MAX, ackKeyOf, ackedIdsOf, applyAcks, bounded, digestOf2, digestText, digestToast, episodesOf, excessAckKeys, excessHistoryKeys, historyKeyOf, markedIdsOf, mergeHistory, occurrencesOf, pendingIdsOf } from '../hooks/alerts'
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
  test('at most four projects keep a history key; the oldest go, never the one being written', () => {
    const names = ['1', '2', '3', '4', '5', '6'].map(c => historyKeyOf(c.repeat(12)))
    expect(excessHistoryKeys(names, names[5]!)).toEqual([names[0], names[1]])
    expect(excessHistoryKeys(names, names[0]!)).toEqual([names[1], names[2]])
    expect(excessHistoryKeys([...names.slice(0, HISTORY_PROJECTS_MAX), 'alert-history', 'alert-history:../x'], names[0]!)).toEqual([])
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

describe('the history merge: stale snapshots, interleaved sessions, conflicting acknowledgments', () => {
  const mk = (n: number, base = 0): AlertRecord[] => written(...Array.from({ length: n }, (_, i) => rec(`t${base + i}:run-blocked:task`, { at: 1000 + base + i, taskId: base + i })))
  test('a stale session writing over a newer history keeps the occurrences it never saw', () => {
    const stale = mk(2, 0)
    const newer = mk(3, 10)
    const out = mergeHistory(stale, newer)
    expect(out.map(r => r.key)).toEqual([...newer.map(r => r.key), ...stale.map(r => r.key)])
    expect(out.length).toBeLessThanOrEqual(ALERT_CAP)
  })
  test('an acknowledgment the store holds is never lost to a stale copy: the merge applies it to both sides', () => {
    const stale = mk(2, 0)
    const newer = mk(2, 10)
    const ids = new Set([idsOf(stale)[0]!, idsOf(newer)[1]!])
    const out = mergeHistory(stale, newer, ids)
    expect(ackedOf(out)).toEqual([...ids].sort())
  })
  test('a stored occurrence of a condition this session also holds records of is not added: two runs of one key would become one and lose an id', () => {
    const k = 'u1:run-blocked:task'
    const stale = written(rec(k, { at: 1000 }))
    const own = written(rec(k, { at: 1000 }), rec(k, { outcome: 'resolved', attempts: 0, channel: null, at: 2000 }), rec(k, { at: 3000 }))
    const out = mergeHistory(own.slice(1), stale)
    expect(idsOf(out)).toEqual(idsOf(own.slice(1)))
    const idsNow = new Set([idsOf(own)[1]!])
    expect(ackedOf(mergeHistory(own.slice(1), stale, idsNow))).toEqual([...idsNow])
  })
  test('an acknowledgment marked in either copy survives the merge (history written before v0.5.8 carried them there)', () => {
    const stale = mk(2, 0)
    const newer = applyAcks(mk(2, 10), new Set([idsOf(mk(2, 10))[0]!]))
    const out = mergeHistory(stale, newer)
    expect(ackedOf(out)).toEqual(ackedOf(newer))
    const out2 = mergeHistory(applyAcks(stale, new Set([idsOf(stale)[1]!])), mk(2, 10))
    expect(ackedOf(out2)).toEqual([idsOf(stale)[1]])
  })
  test('conflicting acknowledgments of different occurrences by two sessions both hold, whatever the order they are applied in', () => {
    const base = mk(4, 0)
    const [w, x, y, z] = idsOf(base)
    const sessionA = new Set([w!, x!])
    const sessionB = new Set([x!, z!])
    const ab = mergeHistory(base, base, new Set([...sessionA, ...sessionB]))
    const ba = mergeHistory(base, base, new Set([...sessionB, ...sessionA]))
    expect(ackedOf(ab)).toEqual([w, x, z].sort())
    expect(ackedOf(ba)).toEqual(ackedOf(ab))
    expect(ackedOf(ab)).not.toContain(y)
  })
  test('the same acknowledgment made twice is the same acknowledgment; merging twice is merging once', () => {
    const base = mk(3, 0)
    const ids = new Set([idsOf(base)[0]!])
    const once = mergeHistory(base, mk(2, 10), ids)
    expect(mergeHistory(once, mk(2, 10), ids)).toEqual(once)
    expect(mergeHistory(applyAcks(base, ids), mk(2, 10), ids)).toEqual(once)
  })
  test('the merge is bounded, and the records it gives up are the ones this session never saw', () => {
    const own = mk(20, 0)
    const stored = mk(ALERT_CAP, 100)
    const out = mergeHistory(own, stored)
    expect(out.length).toBe(ALERT_CAP)
    expect(out.slice(-20).map(r => r.key)).toEqual(own.map(r => r.key))
  })
  test('over many interleavings no acknowledgment, once made, is ever shown as undone', () => {
    // a hand-built schedule of two sessions with stale snapshots: each step is a write of a stale or fresh copy, an
    // acknowledgment key appearing, or a new occurrence; an acknowledgment key is only ever added
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = lcg(seed)
      let store: AlertRecord[] = mk(3, 0)
      const acks = new Set<string>()
      let a: AlertRecord[] = store
      let b: AlertRecord[] = store
      let n = 3
      for (let step = 0; step < 30; step++) {
        const r = rnd()
        if (r < 0.25) { const ids = idsOf(store); if (ids.length > 0) acks.add(ids[Math.floor(rnd() * ids.length)]!) }
        else if (r < 0.5) { a = bounded(a, rec(`t${n}:run-blocked:task`, { at: 2000 + n, taskId: n })); n++ }
        else if (r < 0.7) { b = bounded(b, rec(`t${n}:security-failure:SECURITY`, { kind: 'security-failure', at: 2000 + n, taskId: n })); n++ }
        else {
          // a write of a stale or fresh copy, reading the acknowledgment keys as they stand
          store = mergeHistory(r < 0.85 ? a : b, store, acks)
          for (const id of acks) {
            if (idsOf(store).includes(id)) expect(ackedOf(store)).toContain(id)
          }
        }
        expect(store.length).toBeLessThanOrEqual(ALERT_CAP)
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
    const hist = w.storeWrites.filter(s => s.key === historyKeyOf(project)).at(-1)!.value as { alerts: AlertRecord[] }
    expect(ackedOf(hist.alerts)).toContain(id)
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
