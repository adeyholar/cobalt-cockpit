// Cobalt Guard: owner alerts are opt-in, deduplicated, throttled, private, and never change a verdict.

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_GUARD, bounded, decide, dueOf, guardConfigOf, guardText, labelOf, messageOf } from '../hooks/alerts'
import type { AlertRecord, Facts } from '../hooks/alerts'
import { command, planAndComplete, progress, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const armed = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 2, guardCooldownSec: 30, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const facts = (over: Partial<Facts> = {}): Facts => ({ taskId: 1, securityFailed: false, stopBlocker: null, blocker: null, releaseNoGo: false, reviewOpen: false, atStop: false, ...over })
const on1 = guardConfigOf({ guardAlerts: true })
const sent = (key: string, outcome: AlertRecord['outcome'] = 'sent'): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1, outcome, attempts: 1, channel: 'kitty' })

describe('policy', () => {
  test('off by default; nothing is due for a healthy or merely failing task', () => {
    expect(guardConfigOf({}).enabled).toBe(false)
    expect(dueOf(facts())).toEqual([])
    expect(decide(guardConfigOf({}), EMPTY_GUARD, [], 'k', 0)).toEqual({ send: false, why: 'off' })
  })
  test('security, release NO-GO, exhausted retries, blocked runs and an open review at stop are due', () => {
    expect(dueOf(facts({ securityFailed: true })).map(d => d.kind)).toEqual(['security-failure'])
    expect(dueOf(facts({ releaseNoGo: true })).map(d => d.kind)).toEqual(['release-no-go'])
    expect(dueOf(facts({ stopBlocker: 'x', blocker: 'x' })).map(d => d.kind)).toEqual(['verification-exhausted'])
    expect(dueOf(facts({ blocker: 'x' })).map(d => d.kind)).toEqual(['run-blocked'])
    expect(dueOf(facts({ reviewOpen: true }))).toEqual([])
    expect(dueOf(facts({ reviewOpen: true, atStop: true })).map(d => d.kind)).toEqual(['review-hold'])
  })
  test('deduplicated, throttled, budgeted and silenced', () => {
    const key = '1:run-blocked:task'
    expect(decide(on1, EMPTY_GUARD, [sent(key)], key, 5)).toMatchObject({ why: 'duplicate' })
    expect(decide(on1, { ...EMPTY_GUARD, sentAt: 1000, count: 1 }, [], key, 2000)).toMatchObject({ why: 'throttled' })
    expect(decide(on1, { ...EMPTY_GUARD, count: 5 }, [], key, 9e9)).toMatchObject({ why: 'budget' })
    expect(decide(on1, { ...EMPTY_GUARD, all: true }, [], key, 9e9)).toMatchObject({ why: 'silenced' })
    expect(decide(on1, EMPTY_GUARD, [sent(key, 'failed')], key, 9e9)).toMatchObject({ why: 'duplicate' })
  })
  test('the message is a closed vocabulary and the ledger list is bounded', () => {
    expect(messageOf('security-failure', 3)).not.toMatch(/\/home|sk-|password/)
    let kept: AlertRecord[] = []
    for (let n = 0; n < 100; n++) kept = bounded(kept, sent(`k${n}`))
    expect(kept.length).toBe(32)
    expect(labelOf(on1, EMPTY_GUARD, [])).toBe('ARMED')
    expect(labelOf(on1, { ...EMPTY_GUARD, pending: true }, [])).toBe('ALERT PENDING')
    expect(labelOf(on1, EMPTY_GUARD, [sent('a')])).toBe('SENT')
    expect(labelOf(on1, EMPTY_GUARD, [sent('a', 'failed')])).toBe('FAILED')
    expect(labelOf(on1, EMPTY_GUARD, [{ ...sent('a', 'failed'), acked: true }])).toBe('ARMED')
    expect(guardText(on1, EMPTY_GUARD, [])).toContain('cannot confirm')
  })
})

describe('in a run', () => {
  test('off: a blocked run notifies nobody', { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 1 } }, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1); await stop($)
    expect(w.notified).toEqual([])
  })
  test('a recoverable failure sends nothing; exhausting the budget sends exactly one', armed(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeDefined()
    expect(w.notified.length).toBe(0)
    expect((await stop($)).block).toBeUndefined()
    await stop($); await stop($)
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toContain('retry budget is spent')
    expect(w.notified[0]!.text).not.toContain('check.sh')
  })
  test('a failed security gate sends one alert and does not make the task verified', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'secret in diff' })
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toContain('security check failed')
    expect(String((await command($, 'status')).text)).not.toMatch(/DONE/)
  })
  test('a delivery failure is recorded as FAILED and the task stays BLOCKED', armed(), async ($, on) => {
    const w = world(on); w.notifyMode = 'throws'
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
    const out = String((await command($, 'guard')).text)
    expect(out).toContain('GUARD: FAILED')
    expect(String((await command($, 'status')).text)).toMatch(/BLOCKED/i)
  })
  test('throttled alerts wait for the cooldown and then go out once', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
    await progress($, { action: 'block', milestone: 'm2', note: 'blocked' })
    expect(w.notified.length).toBe(1)
    await w.clock.advance(31_000)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(2)
    await progress($, { action: 'status' })
    expect(w.notified.length).toBe(2)
  })
  test('acknowledging changes the label and nothing else; silencing stops later alerts', armed(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'blocked' })
    const before = String((await command($, 'status')).text)
    expect(String((await command($, 'guard ack')).text)).toContain('GUARD: ARMED')
    expect(String((await command($, 'status')).text)).toBe(before)
    await command($, 'guard silence')
    await w.clock.advance(40_000)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
    expect(w.notified.length).toBe(1)
  })
  test('a disabled host channel is FAILED, not sent', armed(), async ($, on) => {
    const w = world(on); w.notifyMode = 'disabled'
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'blocked' })
    expect(String((await command($, 'guard')).text)).toContain('GUARD: FAILED')
  })
  test('doctor names the guard', armed(), async ($, on) => {
    world(on); await start($)
    expect(String((await command($, 'doctor')).text)).toContain('COBALT GUARD')
  })
})
