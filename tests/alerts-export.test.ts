// v0.6.0 alert maintenance: a bounded, closed-vocabulary export that writes nothing, and a person-confirmed cleanup of the earlier
// history formats that deletes a key only when everything in it exists elsewhere. Synthetic: nothing here shows what anyone saw.

import { describe, expect, test } from 'claude-code/testing'
import { EXPORT_MAX, EXPORT_SCHEMA, ackKeyOf, bounded, episodesOf, exportOf, legacyPlanOf, legacyPlanText, occKeyOf, occurrencesOf } from '../hooks/alerts'
import type { AlertRecord, Open } from '../hooks/alerts'
import type { Ledger } from '../types'
import { hostState, planAndComplete, progress, start, world } from './world'

const P1 = 'a'.repeat(12)
const P2 = 'b'.repeat(12)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const written = (...rs: AlertRecord[]): AlertRecord[] => rs.reduce<AlertRecord[]>((all, r) => bounded(all, r), [])
const idsOf = (kept: readonly AlertRecord[]): string[] => episodesOf(kept).map(e => e.id)
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const sayAs = async ($: any, args: string, origin: unknown) => String(((await $.command.run({ command: 'cockpit', args, origin, presentation: { isFullscreen: true, columns: 120 } } as never)) as { text?: string }).text)
const say = ($: any, args: string) => sayAs($, args, { kind: 'composer' })

describe('the export', () => {
  const sec = 'u1:security-failure:SECURITY'
  const kept = written(
    rec(sec, { kind: 'security-failure', at: 5000 }),
    rec('u1:review-hold:review', { kind: 'review-hold', at: 6000, outcome: 'deferred', channel: null, attempts: 0, why: 'quiet' }),
    rec('u2:run-blocked:task', { at: 7000, outcome: 'recorded', channel: null, attempts: 0 }),
    { ...rec('u3:run-blocked:task', { at: 8000 }), acked: true },
  )
  const open: Open[] = [{ key: sec, kind: 'security-failure' }]
  const parsed = JSON.parse(exportOf(occurrencesOf(kept, open), P1, 9000))
  test('a versioned schema, the project hash, a time, and a count', () => {
    expect(parsed.schema).toBe(EXPORT_SCHEMA)
    expect(parsed.version).toBe(1)
    expect(parsed.project).toBe(P1)
    expect(parsed.exportedAt).toBe('1970-01-01T00:00:09.000Z')
    expect(parsed.count).toBe(4)
    expect(parsed.truncated).toBe(false)
  })
  test('SENT, RECORDED, DEFERRED and ACKNOWLEDGED are separate: the notification outcome is one field and the acknowledgment another', () => {
    expect(parsed.occurrences.map((o: any) => [o.kind, o.notification, o.acknowledged, o.condition])).toEqual([
      ['security-failure', 'SENT', false, 'OPEN'],
      ['review-hold', 'DEFERRED', false, 'ENDED'],
      ['run-blocked', 'RECORDED', false, 'ENDED'],
      ['run-blocked', 'SENT', true, 'ENDED'],
    ])
    expect(parsed.occurrences[0].channel).toBe('kitty')
    expect(parsed.occurrences[2].channel).toBeNull()
  })
  test('every field is a closed word, a number, an id, a hash or a time: no key, task identity, path or free text', () => {
    const text = exportOf(occurrencesOf(kept, open), P1, 9000)
    expect(text).not.toContain('u1:')
    expect(text).not.toContain('SECURITY"')
    const allowed = new Set(['id', 'level', 'kind', 'task', 'recordedAt', 'lastRecordedAt', 'condition', 'notification', 'channel', 'reminders', 'acknowledged'])
    for (const o of parsed.occurrences) for (const k of Object.keys(o)) expect(allowed.has(k)).toBe(true)
    expect(Object.keys(parsed).sort()).toEqual(['count', 'exportedAt', 'note', 'occurrences', 'project', 'schema', 'truncated', 'version'].sort())
  })
  test('bounded: at most 64 occurrences, the newest, and truncation says so', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: i.toString(16).padStart(8, '0'), key: `k${i}`, kind: 'run-blocked' as const, level: 'NORMAL' as const, taskId: i, at: i, lastAt: i, status: 'sent' as const, channel: 'kitty', reminders: 0, acked: false, state: 'ended' as const, seq: i }))
    const out = JSON.parse(exportOf(many, P1, 0))
    expect(out.count).toBe(EXPORT_MAX)
    expect(out.truncated).toBe(true)
    expect(out.occurrences[0].task).toBe(80 - EXPORT_MAX)
  })
  test('a project name that is not a hash is not printed', () => {
    expect(JSON.parse(exportOf([], '/home/user/x', 0)).project).toBeNull()
  })
})

describe('the cleanup plan for the earlier formats', () => {
  const legacy = written(rec('t1:run-blocked:task'), rec('t2:run-blocked:task', { at: 2000 }))
  const [i1, i2] = idsOf(legacy)
  test('nothing in the store, nothing to do', () => {
    expect(legacyPlanText(legacyPlanOf([], []))).toContain('none in the store')
  })
  test('a key is deletable only when every occurrence it holds has a key of its own; otherwise it is kept', () => {
    const values = [{ key: 'alert-history', value: { v: 1, projects: { [P1]: legacy } } }]
    const partly = legacyPlanOf(values, [occKeyOf(P1, i1!)])
    expect(partly.deletable).toEqual([])
    expect(partly.kept).toEqual(['alert-history'])
    expect(legacyPlanText(partly)).toContain('1 NOT migrated: KEPT')
    const whole = legacyPlanOf(values, [occKeyOf(P1, i1!), occKeyOf(P1, i2!)])
    expect(whole.deletable).toEqual(['alert-history'])
    expect(legacyPlanText(whole)).toContain(`/cockpit alerts legacy delete ${whole.token}`)
  })
  test('a project in the single key that was never migrated keeps the whole key', () => {
    const values = [{ key: 'alert-history', value: { v: 1, projects: { [P1]: legacy, [P2]: written(rec('t9:run-blocked:task')) } } }]
    expect(legacyPlanOf(values, [occKeyOf(P1, i1!), occKeyOf(P1, i2!)]).deletable).toEqual([])
  })
  test('another project\'s occurrence key does not count as a migration of this one', () => {
    const values = [{ key: `alert-history:${P1}`, value: { v: 1, alerts: legacy } }]
    expect(legacyPlanOf(values, [occKeyOf(P2, i1!), occKeyOf(P2, i2!)]).deletable).toEqual([])
    expect(legacyPlanOf(values, [occKeyOf(P1, i1!), occKeyOf(P1, i2!)]).deletable).toEqual([`alert-history:${P1}`])
  })
  test('a value not understood in full is never deletable', () => {
    for (const value of ['x', 7, null, { v: 2 }, { v: 1, projects: 'x' }, { v: 1, projects: { [P1]: [...legacy, { key: 7 }] } }, { v: 1, projects: { '../etc': [] } }]) {
      const plan = legacyPlanOf([{ key: 'alert-history', value }], [occKeyOf(P1, i1!), occKeyOf(P1, i2!)])
      expect(plan.deletable).toEqual([])
    }
  })
  test('the code names this plan: a change in the store changes it', () => {
    const values = [{ key: 'alert-history', value: { v: 1, projects: { [P1]: legacy } } }]
    const a = legacyPlanOf(values, [occKeyOf(P1, i1!), occKeyOf(P1, i2!)])
    const b = legacyPlanOf(values, [occKeyOf(P1, i1!)])
    expect(a.token).toMatch(/^[0-9a-f]{8}$/)
    expect(a.token).not.toBe(b.token)
    expect(legacyPlanOf(values, [occKeyOf(P1, i1!), occKeyOf(P1, i2!)]).token).toBe(a.token)
  })
})

describe('in a run', () => {
  test('the export is printed for the person, writes nothing, applies acknowledgments in memory and changes no record', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
    const project = ledger(held).alertsProject!
    const id = idsOf(ledger(held).alerts ?? [])[0]!
    w.store.set(ackKeyOf(project, id), { v: 1 })
    const before = JSON.stringify(ledger(held).alerts)
    const writes = w.storeWrites.length
    const out = JSON.parse(await say($, 'alerts export'))
    expect(out.occurrences[0]).toMatchObject({ id, notification: 'SENT', acknowledged: true, condition: 'OPEN' })
    expect(JSON.stringify(ledger(held).alerts)).toBe(before)
    expect(w.storeWrites.length).toBe(writes)
    expect(w.notified).toHaveLength(1)
    expect(await sayAs($, 'alerts export', { kind: 'sdk' })).toContain('only for a command you type')
  })
  test('the cleanup: a dry run changes nothing, a person deletes only what is safe with the code, and a stale code deletes nothing', { options: { guardRecordOnly: true } }, async ($, on) => {
    const legacy = written(rec('t1:run-blocked:task'))
    const id = idsOf(legacy)[0]!
    const w = world(on, {}, { 'alert-history': { v: 1, projects: { [P1]: legacy, [P2]: written(rec('t9:run-blocked:task')) } }, [occKeyOf(P1, id)]: { v: 1, records: legacy } }); hostState(on, {}); session(on)
    await start($)
    const dry = await say($, 'alerts legacy')
    expect(dry).toContain('DRY RUN · nothing was changed')
    expect(dry).toContain(`project ${P2} · 1 occurrence · 0 with keys of their own · 1 NOT migrated: KEPT`)
    expect(dry).toContain('Nothing can be deleted safely')
    expect(await say($, 'alerts legacy delete 00000000')).toContain('does not match')
    expect(w.store.has('alert-history')).toBe(true)
    // the other project's occurrence is migrated by a session there; simulated by its key appearing
    w.store.set(occKeyOf(P2, idsOf(written(rec('t9:run-blocked:task')))[0]!), { v: 1, records: written(rec('t9:run-blocked:task')) })
    const ready = await say($, 'alerts legacy')
    const code = /legacy delete ([0-9a-f]{8})/.exec(ready)![1]!
    expect(await sayAs($, `alerts legacy delete ${code}`, { kind: 'sdk' })).toContain('only by a command you type')
    expect(w.store.has('alert-history')).toBe(true)
    // a code from before a change in the store is refused
    w.store.set(`alert-history:${P1}`, { v: 1, alerts: legacy })
    expect(await say($, `alerts legacy delete ${code}`)).toContain('does not match')
    expect(w.store.has('alert-history')).toBe(true)
    const fresh = /legacy delete ([0-9a-f]{8})/.exec(await say($, 'alerts legacy'))![1]!
    const done = await say($, `alerts legacy delete ${fresh}`)
    expect(done).toContain('deleted alert-history')
    expect(w.store.has('alert-history')).toBe(false)
    expect(w.store.has(occKeyOf(P1, id))).toBe(true)
  })
  test('usage errors change nothing', async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($)
    expect(await say($, 'alerts legacy remove x')).toContain('Usage')
    expect(await say($, 'alerts export now')).toContain('Usage')
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-'))).toEqual([])
  })
})
