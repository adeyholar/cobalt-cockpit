// v0.5.4 persistent alerts: an alerted condition that stays open is repeated, bounded four ways; an acknowledgment, a silence
// or a resolution ends it; one timer owns it; and none of it changes a verdict or carries anything but a closed sentence.

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_GUARD, closedOf, decide, episodeOf, guardConfigOf, guardText, hasReminderLeft, labelOf, noticedOf, remind, reminderOf } from '../hooks/alerts'
import type { AlertRecord } from '../hooks/alerts'
import { emptyLedger, migrateLedger } from '../hooks/ledger'
import { applyAction, newTask, setGate, settle } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { FIVE, command, hostState, planAndComplete, plays, progress, start, world } from './world'

const OPTS = { guardAlerts: true, guardRepeat: true, guardCooldownSec: 30, guardRepeatSec: 60, guardMaxReminders: 2 }
const armed = (extra: Record<string, unknown> = {}) => ({ options: { ...OPTS, ...extra } })
const cfg = guardConfigOf(OPTS)
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'security-failure', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const outcomes = (held: ReturnType<typeof hostState>) => (ledger(held).alerts ?? []).map(a => `${a.kind}:${a.outcome}${a.nth === undefined ? '' : `#${a.nth}`}`)
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const MIN = 60_000

describe('configuration', () => {
  test('persistence and sound are off by default and do nothing without guardAlerts', () => {
    expect(guardConfigOf({})).toMatchObject({ enabled: false, repeat: false, sound: false })
    expect(guardConfigOf({ guardAlerts: true })).toMatchObject({ enabled: true, repeat: false, sound: false, repeatMs: 900_000, maxReminders: 3 })
    expect(guardConfigOf({ guardRepeat: true, guardSound: true })).toMatchObject({ enabled: false, repeat: false, sound: false })
    expect(guardConfigOf({ guardAlerts: true, guardRepeat: 'yes', guardSound: 1 })).toMatchObject({ repeat: false, sound: false })
  })
  test('the interval and the reminder cap are clamped', () => {
    expect(guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 1, guardMaxReminders: 999 })).toMatchObject({ repeatMs: 60_000, maxReminders: 10 })
    expect(guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 1e12, guardMaxReminders: -4 })).toMatchObject({ repeatMs: 86_400_000, maxReminders: 1 })
    expect(guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: Number.NaN, guardMaxReminders: 'x' })).toMatchObject({ repeatMs: 900_000, maxReminders: 3 })
  })
})

describe('reminder policy', () => {
  const k = '1@0:security-failure:SECURITY'
  test('nothing is repeated while persistence is off, or before the first alert was written', () => {
    expect(remind(guardConfigOf({ guardAlerts: true }), EMPTY_GUARD, [rec(k)], k, 9e9)).toEqual({ send: false, why: 'off' })
    expect(remind(cfg, EMPTY_GUARD, [], k, 9e9)).toEqual({ send: false, why: 'not-alerted' })
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { outcome: 'failed' })], k, 9e9)).toEqual({ send: false, why: 'not-alerted' })
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { outcome: 'throttled' })], k, 9e9)).toEqual({ send: false, why: 'not-alerted' })
  })
  test('it waits for the interval, then counts up to the cap', () => {
    expect(remind(cfg, EMPTY_GUARD, [rec(k)], k, 1000 + MIN - 1)).toEqual({ send: false, why: 'waiting' })
    expect(remind(cfg, EMPTY_GUARD, [rec(k)], k, 1000 + MIN)).toEqual({ send: true, nth: 1 })
    const one = [rec(k), rec(k, { at: 70_000, nth: 1 })]
    expect(remind(cfg, EMPTY_GUARD, one, k, 70_000 + MIN - 1)).toEqual({ send: false, why: 'waiting' })
    expect(remind(cfg, EMPTY_GUARD, one, k, 70_000 + MIN)).toEqual({ send: true, nth: 2 })
    expect(remind(cfg, EMPTY_GUARD, [...one, rec(k, { at: 140_000, nth: 2 })], k, 9e9)).toEqual({ send: false, why: 'spent' })
  })
  test('a reminder that failed to send still counts: a broken channel is not retried without end', () => {
    const kept = [rec(k), rec(k, { at: 70_000, nth: 1, outcome: 'failed', channel: null, why: 'error' }), rec(k, { at: 140_000, nth: 2, outcome: 'refused', channel: null, why: 'refused' })]
    expect(remind(cfg, EMPTY_GUARD, kept, k, 9e9)).toEqual({ send: false, why: 'spent' })
  })
  test('an acknowledgment or a silence ends it; the cooldown and the budget hold it back', () => {
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { acked: true })], k, 9e9)).toEqual({ send: false, why: 'acknowledged' })
    expect(remind(cfg, { ...EMPTY_GUARD, all: true }, [rec(k)], k, 9e9)).toEqual({ send: false, why: 'silenced' })
    expect(remind(cfg, { ...EMPTY_GUARD, silenced: [k] }, [rec(k)], k, 9e9)).toEqual({ send: false, why: 'silenced' })
    expect(remind(cfg, { ...EMPTY_GUARD, sentAt: 100_000, count: 1 }, [rec(k)], k, 100_000 + 29_000)).toEqual({ send: false, why: 'throttled' })
    // the session's last alert is never a reminder's
    expect(remind(cfg, { ...EMPTY_GUARD, count: 4 }, [rec(k)], k, 9e9)).toEqual({ send: false, why: 'budget' })
    expect(remind(cfg, { ...EMPTY_GUARD, count: 3 }, [rec(k)], k, 9e9)).toEqual({ send: true, nth: 1 })
  })
  test('a clock that went backwards waits', () => {
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { at: 5_000_000 })], k, 1)).toEqual({ send: false, why: 'waiting' })
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { at: Number.NaN })], k, 9e9)).toEqual({ send: false, why: 'waiting' })
  })
  test('a resolved condition starts a new occurrence: its old records, acknowledgment and count are behind it', () => {
    const kept = [rec(k, { acked: true }), rec(k, { at: 70_000, nth: 1, acked: true }), rec(k, { at: 80_000, outcome: 'resolved', attempts: 0, channel: null })]
    expect(episodeOf(kept, k)).toEqual([])
    expect(decide(cfg, EMPTY_GUARD, kept, k, 9e9)).toEqual({ send: true, attempts: 1 })
    const again = [...kept, rec(k, { at: 90_000 })]
    expect(decide(cfg, EMPTY_GUARD, again, k, 9e9)).toMatchObject({ why: 'duplicate' })
    expect(remind(cfg, EMPTY_GUARD, again, k, 90_000 + MIN)).toEqual({ send: true, nth: 1 })
  })
  test('what is noticed, what has closed and whether a timer is still needed', () => {
    const other = '1@0:run-blocked:task'
    const kept = [rec(k), rec(other, { kind: 'run-blocked', outcome: 'throttled', attempts: 0, channel: null, why: 'cooldown' })]
    expect(noticedOf(kept).map(a => a.key)).toEqual([k])
    expect(closedOf(kept, [k, other])).toEqual([])
    expect(closedOf(kept, [other]).map(a => a.key)).toEqual([k])
    expect(closedOf([...kept, rec(k, { outcome: 'resolved' })], [])).toEqual([])
    expect(hasReminderLeft(cfg, EMPTY_GUARD, kept)).toBe(true)
    expect(hasReminderLeft(cfg, { ...EMPTY_GUARD, all: true }, kept)).toBe(false)
    expect(hasReminderLeft(cfg, EMPTY_GUARD, [rec(k, { acked: true })])).toBe(false)
    expect(hasReminderLeft(cfg, EMPTY_GUARD, [rec(k), rec(k, { nth: 1 }), rec(k, { nth: 2 })])).toBe(false)
    expect(hasReminderLeft(guardConfigOf({ guardAlerts: true }), EMPTY_GUARD, kept)).toBe(false)
    expect(hasReminderLeft(cfg, EMPTY_GUARD, [])).toBe(false)
  })
  test('the reminder is one closed sentence and two numbers; the label rests once the condition is resolved', () => {
    expect(reminderOf('run-blocked', 7, 2, 3)).toBe('Cobalt Guard · task 7, still open (reminder 2 of 3): the run is blocked and needs you. Nothing was approved or released. /cockpit guard ack stops reminders')
    expect(labelOf(cfg, EMPTY_GUARD, [rec(k)])).toBe('SENT')
    expect(labelOf(cfg, EMPTY_GUARD, [rec(k), rec(k, { outcome: 'resolved' })])).toBe('ARMED')
    const text = guardText(cfg, EMPTY_GUARD, [rec(k), rec(k, { at: 70_000, nth: 1, cue: 'bell' })])
    expect(text).toContain('Persistent: on')
    expect(text).toContain('OPEN security-failure · task 1 · reminders 1 of 2 · reminding')
    expect(text).toContain('(reminder 1)')
    expect(text).toContain('bell attempted')
    expect(guardText(guardConfigOf({ guardAlerts: true }), EMPTY_GUARD, [])).toContain('Persistent: off')
    expect(guardText(guardConfigOf({}), EMPTY_GUARD, [])).not.toContain('Persistent')
  })
  test('malformed persisted reminder fields are dropped, well-formed ones are kept', () => {
    const good = [rec(k, { nth: 1, cue: 'sound' }), rec(k, { outcome: 'resolved', attempts: 0, channel: null }), rec(k, { nth: 10, cue: 'bell' })]
    const bad = [{ ...rec(k), nth: 0 }, { ...rec(k), nth: 11 }, { ...rec(k), nth: '1' }, { ...rec(k), nth: 1.5 }, { ...rec(k), cue: 'siren' }, { ...rec(k), cue: '/usr/bin/x' }, { ...rec(k), outcome: 'delivered' }]
    expect(migrateLedger({ ...emptyLedger('s'), alerts: [...good, ...bad] } as never).alerts).toEqual(good)
  })
})

describe('in a run', () => {
  test('with persistence off a written alert is never repeated, and no timer runs', { options: { guardAlerts: true, guardCooldownSec: 30 } }, async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(1)
    expect(outcomes(held)).toEqual(['security-failure:sent'])
  })
  test('an open condition is repeated on the timer alone, at the interval, up to the cap and no further', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified.length).toBe(1)
    await w.clock.advance(MIN - 1000)
    expect(w.notified.length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.notified.length).toBe(2)
    expect(w.notified[1]!.text).toContain('still open (reminder 1 of 2)')
    await w.clock.advance(2 * MIN)
    expect(w.notified.length).toBe(3)
    expect(w.notified[2]!.text).toContain('reminder 2 of 2')
    await w.clock.advance(60 * MIN)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(3)
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:sent#1', 'security-failure:sent#2'])
    expect(String((await command($, 'guard')).text)).toContain('reminders 2 of 2 · reminders spent')
  })
  test('reminders change no gate, hold or percentage', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    const verdict = () => JSON.stringify([task(held).gates, task(held).percent, task(held).review ?? null, task(held).stopHold ?? null, task(held).blocker])
    const before = verdict()
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(3)
    expect(verdict()).toBe(before)
    expect(String((await command($, 'status')).text)).not.toMatch(/DONE/)
  })
  test('an acknowledgment ends the repeats at once and for good', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    await w.clock.advance(MIN + 30_000)
    expect(w.notified.length).toBe(2)
    expect(String((await command($, 'guard ack')).text)).toContain('acknowledged, no more reminders')
    await w.clock.advance(60 * MIN)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(2)
  })
  test('a silence stops everything; unsilence resumes what is still open', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(String((await command($, 'guard silence')).text)).toContain('Silenced for this session')
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(1)
    // the silence acknowledged what was open, so that condition stays quiet; a new one is told again
    await command($, 'guard unsilence')
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(1)
    await progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
    expect(w.notified.length).toBe(2)
    await w.clock.advance(MIN + 30_000)
    expect(w.notified.length).toBe(3)
  })
  test('unsilence is the person\'s alone', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await command($, 'guard silence')
    const out = await $.command.run({ command: 'cockpit', args: 'guard unsilence', origin: { kind: 'sdk' }, presentation: { isFullscreen: true, columns: 120 } } as never) as { text?: string }
    expect(String(out.text)).toContain('only by a command you type')
    expect((held.get('guard-state')!.value as { all: boolean }).all).toBe(true)
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(1)
  })
  test('a condition that no longer holds is recorded resolved, quietly, and is not repeated; if it returns it is told anew', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'pass', evidence: 'fixed' })
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:resolved'])
    expect(String((await command($, 'guard')).text)).toContain('GUARD: ARMED')
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(1)
    await failSecurity($)
    expect(w.notified.length).toBe(2)
    expect(w.notified[1]!.text).not.toContain('still open')
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:resolved', 'security-failure:sent'])
  })
  test('a reset ends the repeats of the task that is gone', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await command($, 'reset')
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(1)
    expect(outcomes(held).filter(o => o.endsWith(':resolved')).length).toBeLessThanOrEqual(1)
  })
  test('a new task does not inherit the old one\'s reminders', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    await command($, 'reset'); await planAndComplete($, 1)
    await w.clock.advance(10 * MIN)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(1)
  })
  test('the session ending cancels the timer', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    await $.session.end({ reason: 'exit', sessionId: 's1' } as never)
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(1)
  })
  test('a notification that keeps failing is attempted a bounded number of times and never reads SENT', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    w.notifyMode = 'throws'
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(3)
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:failed#1', 'security-failure:failed#2'])
    expect(String((await command($, 'guard')).text)).toContain('GUARD: FAILED')
    expect(task(held).gates.SECURITY.state).toBe('fail')
  })
  test('a first alert that was never written is retried by the existing rule, not by reminders', armed(), async ($, on) => {
    const w = world(on); w.notifyMode = 'disabled'; const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await w.clock.advance(60 * MIN)
    for (let n = 0; n < 6; n++) { await progress($, { action: 'status' }); await w.clock.advance(MIN) }
    expect(outcomes(held)).toEqual(['security-failure:failed', 'security-failure:failed', 'security-failure:failed'])
  })
  test('reminders stay inside the session budget and leave its last alert for a new condition', armed({ guardMaxAlerts: 2, guardMaxReminders: 10 }), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(1)
    await progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
    expect(w.notified.length).toBe(2)
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(2)
  })
  test('two open conditions never go out closer together than the cooldown', armed({ guardCooldownSec: 120, guardMaxReminders: 1, guardMaxAlerts: 20 }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await progress($, { action: 'block', milestone: 'm2', note: 'blocked' })
    await w.clock.advance(60 * MIN)
    const at = (ledger(held).alerts ?? []).filter(a => a.outcome === 'sent').map(a => a.at)
    expect(at.length).toBe(4)
    for (let n = 1; n < at.length; n++) expect(at[n]! - at[n - 1]!).toBeGreaterThanOrEqual(120_000)
    expect(w.notified.length).toBe(4)
  })
  test('nothing a model wrote reaches a notification', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'rm -rf /home/user/.ssh/id_rsa TOKEN=sk-live-123 see src/secret.ts' })
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBe(3)
    for (const n of w.notified) {
      expect(n.text).toMatch(/^Cobalt Guard · task \d+(?:, still open \(reminder \d+ of \d+\))?: the run is blocked and needs you\. Nothing was approved or released\. \/cockpit guard(?: ack stops reminders)?$/)
      expect(n.title).toBe('Cobalt Guard')
    }
  })
})

describe('sound', () => {
  test('off by default: an alert plays nothing', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(plays(w, 'checkpoint')).toEqual([])
  })
  test('guardSound tries the existing cue with the alert and each reminder, and records it as attempted', armed({ guardSound: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(plays(w, 'checkpoint').length).toBe(1)
    await w.clock.advance(MIN + 30_000)
    expect(plays(w, 'checkpoint').length).toBe(2)
    expect((ledger(held).alerts ?? []).map(a => a.cue)).toEqual(['sound', 'sound'])
    expect(String((await command($, 'guard')).text)).toContain('sound attempted')
  })
  test('with no audio player the terminal bell is the fallback, also when the notification itself failed', armed({ guardSound: true }), async ($, on) => {
    const w = world(on, { players: { sh: 'ok' } }); w.notifyMode = 'disabled'; const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.runs.some(r => r[0] === 'sh' && r.join(' ').includes('/dev/tty'))).toBe(true)
    expect((ledger(held).alerts ?? [])[0]).toMatchObject({ outcome: 'failed', why: 'disabled', cue: 'bell' })
  })
  test('/cockpit mute and a machine with no player stay silent, and the alert is still recorded', armed({ guardSound: true }), async ($, on) => {
    const w = world(on, { players: {} }); const held = hostState(on, {})
    await start($); await command($, 'mute'); await planAndComplete($, 1); await failSecurity($)
    expect(plays(w, 'checkpoint')).toEqual([])
    expect((ledger(held).alerts ?? [])[0]).toMatchObject({ outcome: 'sent' })
    expect((ledger(held).alerts ?? [])[0]!.cue).toBeUndefined()
  })
})

describe('reload and restart', () => {
  const heldTask = (): Task => {
    let t = newTask(1, 'goal', 100, null)
    t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

    return setGate(t, 'SECURITY', 'fail', 'synthetic', 'model', 102)
  }
  const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:security-failure:SECURITY`
  test('a reload resumes the repeats from the kept records: one timer, the count carried on', armed(), async ($, on) => {
    const t = heldTask()
    const kept = [rec(keyOfTask(t), { at: 1 }), rec(keyOfTask(t), { at: 500_000, nth: 1 })]
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: kept } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, { task: t })
    // the module loads, and the host fires session.start again as it does after a save
    await start($); await start($); await start($)
    expect(w.notified).toEqual([])
    await w.clock.advance(31_000)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toContain('reminder 2 of 2')
    await w.clock.advance(60 * MIN)
    expect(w.notified.length).toBe(1)
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:sent#1', 'security-failure:sent#2'])
  })
  test('a reload after an acknowledgment arms nothing', armed(), async ($, on) => {
    const t = heldTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [rec(keyOfTask(t), { at: 1, acked: true })] } })
    on('session.id', () => ({ value: 's1' }))
    hostState(on, { task: t })
    await start($)
    await w.clock.advance(60 * MIN)
    await progress($, { action: 'status' })
    expect(w.notified).toEqual([])
  })
  test('a stored record of a task that is gone is resolved on the first look, never repeated', armed(), async ($, on) => {
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [rec('9@9:security-failure:SECURITY', { at: 1, taskId: 9 })] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, {})
    await start($)
    await w.clock.advance(60 * MIN)
    expect(w.notified).toEqual([])
    expect(outcomes(held)).toEqual(['security-failure:sent', 'security-failure:resolved'])
  })
  test('malformed stored guard state and alerts neither throw nor send', armed(), async ($, on) => {
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [{ key: 7 }, null, 'x', { ...rec('k'), nth: -1 }] } })
    on('session.id', () => ({ value: 's1' }))
    hostState(on, { task: heldTask(), 'guard-state': { sentAt: 'soon', count: 'many', silenced: null, all: 0, pending: true } })
    await start($)
    await w.clock.advance(10 * MIN)
    expect(w.notified.length).toBeLessThanOrEqual(1)
    expect(String((await command($, 'guard')).text)).toContain('GUARD:')
  })
})
