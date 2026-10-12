// v0.5.9 record-only mode and the since-last-look summary. Record-only writes incidents down and never calls the host's
// notification, a player or the bell; the look marker counts occurrences by identity and is written only by a person's display
// of the inbox. The marker is a read and a write of one key, so it is best effort across sessions and these tests say only what
// that allows. Synthetic: nothing here shows that a person saw, heard or was spared anything.

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_GUARD, OCC_PER_PROJECT, SEEN_IDS_MAX, ackKeyOf, applyAcks, bounded, closedOf, decide, digestText, episodesOf, excessSeenKeys, guardConfigOf, guardText, isAlertRecord, isRecording, labelOf, noticedOf, occKeyOf, occurrencesOf, pageIdsOf, pinLine, pinsOf, policyLines, seenIdsOf, seenKeyOf, sinceLines, sinceOf, withSeen } from '../hooks/alerts'
import type { AlertKind, AlertRecord, Open } from '../hooks/alerts'
import { applyAction, newTask, settle } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { FIVE, command, hostState, mountHud, planAndComplete, plays, progress, rowsOf, start, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const NEVER_CLAIMED = /\b(seen|unseen|heard|delivered|read by|missed|silent(ly)?|disconnect(ed)?|reconnect(ed)?)\b/i
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const recorded = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'recorded', attempts: 0, channel: null, ...over })
const resolved = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'resolved', attempts: 0, channel: null, ...over })
const written = (...rs: AlertRecord[]): AlertRecord[] => rs.reduce<AlertRecord[]>((all, r) => bounded(all, r), [])
const idsOf = (kept: readonly AlertRecord[]): string[] => episodesOf(kept).map(e => e.id)
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const taskOf = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const say = async ($: any, args: string, columns = 120) => String((await $.command.run({ command: 'cockpit', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns } } as never) as { text?: string }).text)
const sayAs = async ($: any, args: string, origin: unknown) => String(((await $.command.run({ command: 'cockpit', args, origin, presentation: { isFullscreen: true, columns: 120 } } as never)) as { text?: string }).text)
const block = ($: any) => progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
const unblock = ($: any) => progress($, { action: 'unblock', milestone: 'm2' })
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const passSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'pass', evidence: 'x' })
const idOf = (text: string, kind: string): string => new RegExp(`\\b([0-9a-f]{8}) (?:CRITICAL|HIGH|NORMAL) ${kind}\\b`).exec(text)?.[1] ?? 'none'
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const guardRow = async ($: any, columns = 120) => (await rowsOf(await mountHud($, 'terminal', columns))).find(r => r.includes('GUARD') || r.includes('▲'))
const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const REC = (extra: Record<string, unknown> = {}) => ({ options: { guardRecordOnly: true, guardCooldownSec: 30, ...extra } })
const ALERTS = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20, ...extra } })
const outcomes = (held: ReturnType<typeof hostState>) => (ledger(held).alerts ?? []).map(a => `${a.kind}:${a.outcome}`)
const blockedTask = (): Task => {
  let t = newTask(1, 'goal', 100, null)
  t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

  return settle(applyAction(t, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
}
const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:run-blocked:task`
const K = (uid: string, kind: AlertKind, detail: string) => `${uid}:${kind}:${detail}`

describe('the modes', () => {
  test('record-only is off by default, and a setting that is not true is off', () => {
    expect(guardConfigOf({}).recordOnly).toBe(false)
    for (const v of ['true', 1, 'yes', null, {}]) expect(guardConfigOf({ guardRecordOnly: v }).recordOnly).toBe(false)
    expect(guardConfigOf({ guardRecordOnly: true }).recordOnly).toBe(true)
  })
  test('the four combinations: what is recorded and what is told', () => {
    const modes = [
      [{}, false, false],
      [{ guardAlerts: true }, true, true],
      [{ guardRecordOnly: true }, true, false],
      [{ guardAlerts: true, guardRecordOnly: true }, true, true],
    ] as const
    for (const [options, records, notifies] of modes) {
      const cfg = guardConfigOf(options)
      expect([isRecording(cfg), cfg.enabled]).toEqual([records, notifies])
    }
  })
  test('the label names the mode: RECORDING is not ARMED, and alerts on come first when both are on', () => {
    expect(labelOf(guardConfigOf({}), EMPTY_GUARD, [])).toBe('OFF')
    expect(labelOf(guardConfigOf({ guardRecordOnly: true }), EMPTY_GUARD, [])).toBe('RECORDING')
    expect(labelOf(guardConfigOf({ guardAlerts: true }), EMPTY_GUARD, [])).toBe('ARMED')
    expect(labelOf(guardConfigOf({ guardAlerts: true, guardRecordOnly: true }), EMPTY_GUARD, [])).toBe('ARMED')
  })
  test('the status says what each mode does and that record-only does not mute alerts', () => {
    const only = guardText(guardConfigOf({ guardRecordOnly: true }), EMPTY_GUARD, [])
    expect(only).toContain('GUARD: RECORDING')
    expect(only).toContain('No notification, sound or bell is sent')
    expect(only).toContain('is not announced')
    const both = guardText(guardConfigOf({ guardAlerts: true, guardRecordOnly: true }), EMPTY_GUARD, [])
    expect(both).toContain('guardRecordOnly is also on: it changes nothing while alerts are on')
    expect(guardText(guardConfigOf({}), EMPTY_GUARD, [])).toContain('nothing new is recorded while both are off')
  })
  test('record-only lists the active conditions and nothing about priorities, kinds or quiet hours it does not use', () => {
    const k = K('u1', 'security-failure', 'SECURITY')
    const kept = written(recorded(k, { kind: 'security-failure' }))
    const lines = policyLines(guardConfigOf({ guardRecordOnly: true }), kept, { now: 0, open: [{ key: k, kind: 'security-failure' }], channel: null, isSsh: false })
    expect(lines).toEqual(['  ACTIVE CRITICAL security-failure · task 1 · RECORDED, no notification · not acknowledged'])
    expect(policyLines(guardConfigOf({}), kept, { now: 0, open: [], channel: null, isSsh: false })).toEqual([])
  })
})

describe('the recorded outcome', () => {
  const k = K('u1', 'run-blocked', 'task')
  test('it is a valid stored record, and a record with any other outcome name is still refused', () => {
    expect(isAlertRecord(recorded(k))).toBe(true)
    expect(isAlertRecord({ ...recorded(k), outcome: 'recorded-only' })).toBe(false)
  })
  test('it is never described as sent, failed, deferred or held back', () => {
    const o = occurrencesOf(written(recorded(k)), [{ key: k, kind: 'run-blocked' }])[0]!
    expect(o.status).toBe('recorded')
    expect(o.channel).toBeNull()
    expect(o.reminders).toBe(0)
  })
  test('turning alerts on later does not send what was recorded: the occurrence is handled, a recurrence is new', () => {
    const cfg = guardConfigOf({ guardAlerts: true })
    expect(decide(cfg, EMPTY_GUARD, written(recorded(k)), k, 9e9)).toEqual({ send: false, why: 'recorded' })
    expect(decide(cfg, EMPTY_GUARD, written(recorded(k), resolved(k, { at: 2000 })), k, 9e9)).toMatchObject({ send: true })
    expect(decide(cfg, EMPTY_GUARD, [], k, 9e9)).toMatchObject({ send: true })
  })
  test('it closes like a notified occurrence: resolved once when its condition stops holding', () => {
    const kept = written(recorded(k))
    expect(noticedOf(kept).map(a => a.key)).toEqual([k])
    expect(closedOf(kept, []).map(a => a.key)).toEqual([k])
    expect(closedOf(kept, [k])).toEqual([])
  })
  test('the reminder policy ignores it: nothing recorded is repeated', () => {
    const text = guardText(guardConfigOf({ guardAlerts: true, guardRepeat: true }), EMPTY_GUARD, written(recorded(k)))
    expect(text).toContain('recorded only, no reminders')
    expect(text).not.toContain('reminding')
  })
})

describe('since your last look, by identity', () => {
  const a = K('u1', 'security-failure', 'SECURITY')
  const b = K('u1', 'review-hold', 'review')
  const c = K('u1', 'run-blocked', 'task')
  const kept = written(
    rec(a, { kind: 'security-failure', at: 5000 }),
    recorded(b, { kind: 'review-hold', at: 5000 }),
    rec(c, { at: 5000, outcome: 'deferred', channel: null, attempts: 0, why: 'quiet' }),
  )
  const open: Open[] = [{ key: a, kind: 'security-failure' }, { key: b, kind: 'review-hold' }]
  const occ = occurrencesOf(kept, open)
  test('with no look recorded everything is new, and it says so', () => {
    expect(sinceLines(occ, null)[0]).toBe('SINCE LAST LOOK: 1 CRITICAL · 1 HIGH · 1 NORMAL (no earlier look)')
  })
  test('what the last look showed is not new; what it did not show is, whatever the clock says', () => {
    const [ia, ib] = idsOf(kept)
    expect(sinceLines(occ, new Set([ia!, ib!]))[0]).toBe('SINCE LAST LOOK: 1 NORMAL')
    expect(sinceLines(occ, new Set(idsOf(kept)))[0]).toBe('SINCE LAST LOOK: nothing new')
    // equal times, a time before the look, a time after it: only the identity decides
    const later = occurrencesOf(written(rec(a, { kind: 'security-failure', at: 1 }), rec(c, { at: 9e12 })), [])
    expect(sinceOf(later, new Set([idsOf(kept)[0]!])).map(o => o.kind)).toEqual(['security-failure', 'run-blocked'].filter((_, i) => i < 2).filter(() => true).slice(0, 2))
  })
  test('the second line separates active from history and names what became of the notifications, recorded-only included', () => {
    const lines = sinceLines(occurrencesOf(kept, open), null)
    expect(lines[1]).toBe('  active 2 · history 1 · recorded only 1 · SENT 1 · DEFERRED 1')
    const acked = sinceLines(occurrencesOf(applyAcks(kept, new Set([idsOf(kept)[0]!])), open), null)
    expect(acked[1]).toContain('acknowledged 1')
  })
  test('an unacknowledged record is counted, never called unseen or missed', () => {
    for (let width = 0; width <= 140; width += 3) for (const seen of [null, new Set<string>()]) for (const line of sinceLines(occ, seen, width)) {
      expect(line.length).toBeLessThanOrEqual(Math.max(width, 0))
      expect(line).not.toMatch(NEVER_CLAIMED)
    }
  })
  test('narrow: the first line keeps the levels, the second goes first', () => {
    expect(sinceLines(occ, null, 40)[0]!.length).toBeLessThanOrEqual(40)
    expect(sinceLines(occ, null, 35)).toHaveLength(1)
    expect(sinceLines(occ, null, 80)).toHaveLength(2)
  })
  test('the marker: only well-formed ids, capped, and a damaged one means no look is recorded', () => {
    expect([...seenIdsOf({ v: 1, ids: ['0123abcd', 'NOPE', 7, '0123abcd'] })!]).toEqual(['0123abcd'])
    for (const bad of [null, undefined, 'x', 7, [], { v: 2, ids: [] }, { v: 1, ids: 'x' }, { ids: [] }]) expect(seenIdsOf(bad)).toBeNull()
    const many = Array.from({ length: SEEN_IDS_MAX + 20 }, (_, i) => i.toString(16).padStart(8, '0'))
    expect(withSeen(null, many)).toHaveLength(SEEN_IDS_MAX)
    expect(withSeen(null, many).at(-1)).toBe(many.at(-1))
  })
  test('a look writes the union: a look that knew less never forgets what another saw', () => {
    expect(withSeen(new Set(['aaaaaaaa']), ['bbbbbbbb'])).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(withSeen(new Set(['aaaaaaaa', 'bbbbbbbb']), ['bbbbbbbb'])).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })
  test('markers are kept for four projects, the oldest forgotten first, never the one being written', () => {
    const names = ['1', '2', '3', '4', '5', '6'].map(c => seenKeyOf(c.repeat(12)))
    expect(excessSeenKeys(names, names[5]!)).toEqual([names[0], names[1]])
    expect(excessSeenKeys([...names, 'alert-seen:../x', 'ledger:s1'], names[0]!)).toEqual([names[1], names[2]])
  })
  test('a page shows its own ids, and only those are marked', () => {
    let many: AlertRecord[] = []
    for (let i = 0; i < 12; i++) many = bounded(many, rec(`t${i}:run-blocked:task`, { at: 1000 + i, taskId: i }))
    const o = occurrencesOf(many, [])
    const first = pageIdsOf(o, 1)
    const second = pageIdsOf(o, 2)
    expect(first).toHaveLength(8)
    expect(second).toHaveLength(4)
    expect(new Set([...first, ...second]).size).toBe(12)
    expect(pageIdsOf(o, 99)).toEqual(second)
  })
  test('the digest counts what is new from the marker and, as a function, changes nothing', () => {
    const before = JSON.stringify(occ)
    const text = digestText(occ, 9000, true, { seen: new Set([idsOf(kept)[0]!]), columns: 100 })
    expect(text).toContain('SINCE LAST LOOK: 1 HIGH · 1 NORMAL')
    expect(text).toContain('RECORDED only')
    expect(JSON.stringify(occ)).toBe(before)
    expect(digestText(occ, 9000, true)).not.toContain('SINCE LAST LOOK')
  })
  test('record-only is named in the inbox and the digest notes, alerts off still reads as off', () => {
    expect(digestText(occ, 9000, false, { recording: true })).toContain('Record-only (guardRecordOnly): incidents are recorded here; nothing is notified.')
    expect(digestText(occ, 9000, false)).toContain('Alerts are off (guardAlerts)')
  })
})

describe('the HUD row in record-only', () => {
  const pin = { key: 'k', kind: 'security-failure' as const, taskId: 3, level: 'CRITICAL' as const, status: 'recorded' as const, acked: false }
  test('nothing recorded and nothing to count draws nothing', () => {
    expect(pinLine([], false, 'RECORDING', 120, 0)).toBeNull()
  })
  test('the pinned incident says it was recorded, not sent, and keeps the level down to the narrowest band', () => {
    const line = pinLine([pin], false, 'RECORDING', 200)!
    expect(line.text).toBe('GUARD ▲ CRITICAL security check failed · task 3 · RECORDED, no notification · /cockpit alerts')
    expect(line.level).toBe('CRITICAL')
    for (let width = 0; width <= 120; width++) {
      const text = pinLine([pin, { ...pin, kind: 'run-blocked', level: 'NORMAL' }], false, 'RECORDING', width)!.text
      expect(text.length).toBeLessThanOrEqual(width)
      expect(text).not.toMatch(NEVER_CLAIMED)
    }
    expect(pinLine([pin], false, 'RECORDING', 12)!.text).toBe('▲ CRITICAL')
  })
  test('history nobody acknowledged is a count under the RECORDING label', () => {
    expect(pinLine([], false, 'RECORDING', 120, 2)!.text).toBe('GUARD: RECORDING · 2 unacknowledged in history · /cockpit alerts')
    expect(pinsOf([], [])).toEqual([])
  })
})

describe('in a run: record-only', () => {
  test('a blocked run is recorded and nothing is told: no notification, no sound, no bell, no budget used', REC({ guardSound: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(2 * HOUR)
    expect(outcomes(held)).toEqual(['run-blocked:recorded'])
    expect(w.notified).toEqual([])
    expect(plays(w, 'checkpoint')).toEqual([])
    expect(w.runs.filter(r => /pw-play|paplay|afplay|aplay|ffplay|mpv|bell/.test(r.join(' ')))).toEqual([])
    const guardState = held.get('guard-state')?.value as { count: number; sentAt: number | null } | undefined
    expect(guardState?.count ?? 0).toBe(0)
    expect(guardState?.sentAt ?? null).toBeNull()
  })
  test('the inbox shows it as recorded only, with its level, and the digest counts it', REC(), async ($, $on) => {
    const w = world($on); hostState($on, {}); session($on)
    await start($); await planAndComplete($, 1); await failSecurity($); await block($)
    const text = await say($, 'alerts')
    expect(text).toMatch(/CRITICAL security-failure · task 1 · recorded .* · RECORDED only, no notification · not acknowledged · condition OPEN now/)
    expect(text).toContain('Record-only (guardRecordOnly)')
    expect(text.indexOf('CRITICAL security-failure')).toBeLessThan(text.indexOf('NORMAL run-blocked'))
    expect(text).not.toMatch(NEVER_CLAIMED)
    const digest = await say($, 'alerts digest')
    expect(digest).toContain('2 RECORDED only')
    expect(w.notified).toEqual([])
  })
  test('a critical incident stays visible on the HUD, labelled as recorded, until it is acknowledged', REC(), async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(await guardRow($)).toBe('GUARD ▲ CRITICAL security check failed · task 1 · RECORDED, no notification · /cockpit alerts')
    for (const columns of [60, 40, 24, 12]) expect((await guardRow($, columns))!.length).toBeLessThanOrEqual(columns)
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'security-failure')}`)
    expect(await guardRow($)).toBeUndefined()
  })
  test('nothing recorded draws no row at all, and the progress rows are what they were', REC(), async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    expect(await guardRow($)).toBeUndefined()
  })
  test('resolution and recurrence: the second incident is its own occurrence, recorded again, never told', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    const first = idOf(await say($, 'alerts'), 'security-failure')
    await passSecurity($); await progress($, { action: 'status' })
    await failSecurity($)
    expect(outcomes(held)).toEqual(['security-failure:recorded', 'security-failure:resolved', 'security-failure:recorded'])
    const text = await say($, 'alerts')
    expect(new Set([...text.matchAll(/^ {2}([0-9a-f]{8}) /gm)].map(m => m[1])).size).toBe(2)
    expect(text).toContain(first)
    expect(w.notified).toEqual([])
  })
  test('an individual acknowledgment works, is person-only, and writes the shared key', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    expect(await sayAs($, `alerts ack ${id}`, { kind: 'sdk' })).toContain('only by a command you type')
    expect(await say($, `alerts ack ${id}`)).toContain('was acknowledged')
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-ack:')).map(s => s.key)).toEqual([ackKeyOf(ledger(held).alertsProject!, id)])
    expect(w.notified).toEqual([])
  })
  test('silence and the notified kinds govern telling, not recording', REC({ guardNotifyKinds: 'none', guardQuietHours: '23:00-00:30', guardQuietTimezone: 'UTC' }), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    await say($, 'guard silence')
    await block($); await failSecurity($)
    expect(outcomes(held)).toEqual(['run-blocked:recorded', 'security-failure:recorded'])
    await w.clock.advance(3 * HOUR)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).not.toContain('run-blocked:deferred')
  })
  test('there is no timer and no reminder: hours pass and nothing happens', REC({ guardRepeat: true, guardSound: true }), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(6 * HOUR)
    expect(w.notified).toEqual([])
    expect(plays(w, 'checkpoint')).toEqual([])
  })
  test('a transport test the person types is the one thing that sends, and it records no incident', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($)
    const out = await say($, 'guard test')
    expect(out).toContain('TEST notification was SENT')
    expect(w.notified).toHaveLength(1)
    expect(w.notified[0]!.text).toContain('TEST')
    expect(ledger(held).alerts ?? []).toEqual([])
    await planAndComplete($, 1); await block($)
    expect(w.notified).toHaveLength(1)
  })
  test('no gate, hold, review, approval or percentage is touched by recording, looking or acknowledging', REC(), async ($, on) => {
    world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 2); await failSecurity($)
    const before = JSON.stringify(taskOf(held))
    const status = await progress($, { action: 'status' })
    await say($, 'alerts'); await say($, 'alerts digest'); await say($, 'guard'); await say($, `alerts ack ${idOf(await say($, 'alerts'), 'security-failure')}`)
    expect(JSON.stringify(taskOf(held))).toBe(before)
    expect(await progress($, { action: 'status' })).toBe(status)
  })
  test('the guard status and doctor describe the mode and do not fail', REC(), async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const text = await say($, 'guard')
    expect(text).toContain('GUARD: RECORDING')
    expect(text).toContain('ACTIVE NORMAL run-blocked · task 1 · RECORDED, no notification')
    expect(await say($, 'doctor')).toContain('RECORDING (guardRecordOnly); incidents are written down')
  })
})

describe('in a run: both settings off, and both on', () => {
  test('both off: nothing is recorded, told or tied to a project', { options: {} }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($); await failSecurity($)
    expect(ledger(held).alerts).toBeUndefined()
    expect(ledger(held).alertsProject).toBeUndefined()
    expect(w.notified).toEqual([])
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-'))).toEqual([])
    expect(await say($, 'alerts')).toContain('Alerts are off (guardAlerts)')
    expect(await guardRow($)).toBeUndefined()
  })
  test('both on: alerts behave exactly as with alerts alone, and the incident is recorded as it always was, never as recorded-only', { options: { guardAlerts: true, guardRecordOnly: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified).toHaveLength(1)
    expect(outcomes(held)).toEqual(['run-blocked:sent'])
    expect(await guardRow($)).toContain('notification SENT, not acknowledged')
    expect(await say($, 'guard')).toContain('guardRecordOnly is also on')
  })
  test('alerts on alone and both on send the same notification text', { options: { guardAlerts: true, guardRecordOnly: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified[0]!.text).toBe('Cobalt Guard · task 1: a security check failed; the task cannot be called verified. Nothing was approved or released. /cockpit guard')
  })
})

describe('in a run: switching modes', () => {
  const seeded = async (extra: Record<string, unknown> = {}) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    const store: Record<string, unknown> = { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records }, ...extra }

    return { t, project, records, store }
  }
  test('turning alerts on does not announce what was recorded: no backlog, no flood, however long it runs', ALERTS(), async ($, on) => {
    const { t, store } = await seeded()
    const w = world(on, {}, store); hostState(on, { task: t }); session(on, 's2')
    await start($)
    await w.clock.advance(3 * HOUR)
    expect(w.notified).toEqual([])
    expect(await say($, 'alerts')).toContain('RECORDED only, no notification')
  })
  test('a new incident after alerts are turned on is told, with the budget and cooldown fresh', ALERTS(), async ($, on) => {
    const { t, store } = await seeded()
    const w = world(on, {}, store); hostState(on, { task: t }); session(on, 's2')
    await start($)
    await failSecurity($)
    expect(w.notified).toHaveLength(1)
    expect(w.notified[0]!.text).toContain('security check failed')
  })
  test('turning record-only on after alerts leaves sent records alone and tells nothing more', REC(), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const records = written(rec(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, {}, { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records } }); const held = hostState(on, { task: t }); session(on, 's2')
    await start($)
    await w.clock.advance(2 * HOUR)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).not.toContain('run-blocked:recorded')
    expect(await say($, 'alerts')).toContain('notification SENT')
  })
  test('a record-only incident whose condition clears while both are off stays history, not resolved, until a look', { options: {} }, async ($, on) => {
    const { store } = await seeded()
    world(on, {}, store); hostState(on, {}); session(on, 's2')
    await start($)
    const text = await say($, 'alerts')
    expect(text).toContain('condition no longer open (task replaced or gone)')
  })
})

describe('in a run: since your last look', () => {
  test('first look counts everything and says no earlier look; opening it again counts nothing new; a new incident counts one', REC(), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: nothing new')
    await w.clock.advance(31_000)
    await failSecurity($)
    const third = await say($, 'alerts')
    expect(third).toContain('SINCE LAST LOOK: 1 CRITICAL')
    expect(third).not.toContain('(no earlier look)')
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: nothing new')
  })
  test('looking acknowledges nothing, notifies nothing, and writes only the marker', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const before = JSON.stringify(ledger(held).alerts)
    const writes = w.storeWrites.length
    await say($, 'alerts'); await say($, 'alerts')
    expect(JSON.stringify(ledger(held).alerts)).toBe(before)
    expect((ledger(held).alerts ?? []).some(a => a.acked === true)).toBe(false)
    expect(w.storeWrites.slice(writes).map(s => s.key)).toEqual([seenKeyOf(ledger(held).alertsProject!)])
    expect(w.notified).toEqual([])
  })
  test('the digest is read-only: it counts what is new, writes no marker, and leaves the next look counting it', REC(), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const writes = w.storeWrites.length
    const digest = await say($, 'alerts digest')
    expect(digest).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
    expect(await say($, 'alerts digest')).toContain('SINCE LAST LOOK: 1 NORMAL')
    expect(w.storeWrites.slice(writes).filter(s => s.key.startsWith('alert-seen:'))).toEqual([])
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
  })
  test('the session-start digest does not mark the inbox as looked at', REC({ guardDigest: true }), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, {}, { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.toasts.filter(x => x.startsWith('Cobalt alerts'))).toHaveLength(1)
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-seen:'))).toEqual([])
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
  })
  test('only a person\'s look is a look: another origin sees the summary and marks nothing', REC(), async ($, on) => {
    const w = world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    expect(await sayAs($, 'alerts', { kind: 'sdk' })).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
    expect(w.storeWrites.filter(s => s.key.startsWith('alert-seen:'))).toEqual([])
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
  })
  test('a restart keeps the marker; a task reset makes the next incident new; another project has its own marker', REC(), async ($, on) => {
    const project = await projectHash('/work/example')
    const t = blockedTask()
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, {}, {
      [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records },
      [seenKeyOf(project)]: { v: 1, ids: [idsOf(records)[0]!] },
      [seenKeyOf('f'.repeat(12))]: { v: 1, ids: ['00000000'] },
    }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: nothing new')
    await say($, 'reset')
    await planAndComplete($, 1); await failSecurity($)
    expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 CRITICAL')
    void w
  })
  test('a damaged marker means every occurrence is new, and nothing throws', REC(), async ($, on) => {
    const project = await projectHash('/work/example')
    const t = blockedTask()
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    for (const bad of ['text', 7, null, { v: 2, ids: [] }, { v: 1, ids: 'x' }, { v: 1, ids: [7, 'ZZ'] }]) {
      const w = world(on, {}, { [occKeyOf(project, idsOf(records)[0]!)]: { v: 1, records }, [seenKeyOf(project)]: bad }); hostState(on, { task: t }); session(on, 's2')
      await start($)
      expect(await say($, 'alerts')).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
      void w
      break
    }
  })
  test('an acknowledgment made elsewhere is counted as acknowledged, not as new or unseen', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    w.store.set(ackKeyOf(ledger(held).alertsProject!, id), { v: 1 })
    await w.clock.advance(31_000)
    await failSecurity($)
    const text = await say($, 'alerts')
    expect(text).toContain('SINCE LAST LOOK: 1 CRITICAL')
    expect(text).toMatch(/NORMAL run-blocked .* · acknowledged · condition OPEN now/)
  })
  test('narrow terminals: the summary stays within the width given', REC(), async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($); await block($)
    for (const columns of [120, 80, 50, 36, 30]) {
      const lines = (await say($, 'alerts digest', columns)).split('\n').filter(l => l.startsWith('SINCE LAST LOOK') || l.startsWith('  active'))
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns)
    }
  })
  test('with alerts on, the summary is the same and says SENT where the host wrote the notification', ALERTS(), async ($, on) => {
    world(on); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const text = await say($, 'alerts')
    expect(text).toContain('SINCE LAST LOOK: 1 NORMAL (no earlier look)')
    expect(text).toContain('SENT 1')
  })
})

describe('record-only storage: self-healing, and the earlier formats', () => {
  test('an occurrence another session\'s pruning removed is written again at this session\'s next write', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    const project = ledger(held).alertsProject!
    const id = idOf(await say($, 'alerts'), 'security-failure')
    expect(w.store.has(occKeyOf(project, id))).toBe(true)
    w.store.delete(occKeyOf(project, id))
    await w.clock.advance(31_000)
    await block($)
    expect(w.store.has(occKeyOf(project, id))).toBe(true)
  })
  test('the v0.5.8 key of a project is moved to keys of its own when recording is on, and then given up', REC(), async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const earlier = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, {}, { [`alert-history:${project}`]: { v: 1, alerts: earlier }, 'alert-history': { v: 1, projects: { [project]: earlier } } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    expect(w.store.has(`alert-history:${project}`)).toBe(false)
    expect(w.store.has(occKeyOf(project, idsOf(earlier)[0]!))).toBe(true)
    // the v0.5.7 single key is left as it was
    expect(w.store.has('alert-history')).toBe(true)
    expect(await say($, 'alerts')).toContain('RECORDED only, no notification')
  })
  test('with both settings off the earlier formats are read and nothing is copied or deleted', { options: {} }, async ($, on) => {
    const t = blockedTask()
    const project = await projectHash('/work/example')
    const earlier = written(rec(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, {}, { [`alert-history:${project}`]: { v: 1, alerts: earlier } }); hostState(on, { task: t }); session(on, 's2')
    await start($)
    await progress($, { action: 'status' })
    expect(await say($, 'alerts')).toContain('1 recorded')
    expect(w.store.has(`alert-history:${project}`)).toBe(true)
    expect([...w.store.keys()].filter(k => k.startsWith('alert-occ:'))).toEqual([])
    expect(w.storeWrites.filter(x => x.key.startsWith('alert-'))).toEqual([])
  })
})

describe('record-only storage: the same bounds as alerts', () => {
  test('occurrences are keys of their own, bounded per project, and carry only the closed vocabulary', REC(), async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    for (let i = 0; i < 20; i++) {
      await failSecurity($); await passSecurity($); await progress($, { action: 'status' })
      await w.clock.advance(31_000)
    }
    const project = ledger(held).alertsProject!
    const mine = [...w.store.keys()].filter(k => k.startsWith(`alert-occ:${project}:`))
    expect(mine.length).toBeLessThanOrEqual(OCC_PER_PROJECT)
    for (const k of mine) {
      const value = w.store.get(k) as { v: number; records: AlertRecord[] }
      expect(value.records.every(isAlertRecord)).toBe(true)
      expect(JSON.stringify(value)).not.toContain('/work/example')
    }
    expect((ledger(held).alerts ?? []).length).toBeLessThanOrEqual(32)
  })
  test('another project does not see the record-only history', REC(), async ($, on) => {
    const t = blockedTask()
    const records = written(recorded(keyOfTask(t), { at: 1, taskId: t.id }))
    const w = world(on, { cwd: '/work/another' }, { [occKeyOf(await projectHash('/work/example'), idsOf(records)[0]!)]: { v: 1, records } }); hostState(on, {}); session(on, 's2')
    await start($)
    expect(await say($, 'alerts')).toContain('Nothing recorded.')
    expect(w.notified).toEqual([])
  })
})
