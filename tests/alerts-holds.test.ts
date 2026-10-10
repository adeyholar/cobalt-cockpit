// Cobalt Guard and the Stop guard beside a mandatory review: an alert or a passing check never clears, approves or reverses anything.

import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { applyAction, newTask, setGate, settle } from '../hooks/model'
import type { AlertRecord, Ledger, Task } from '../types'
import { FIVE, GATE_NAMES, command, hostState, progress, prompt, start, world } from './world'

type Engine = Parameters<typeof start>[0]
const A = 'a'.repeat(40)
const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const OPTS = { orchestration: true, profile: 'SONNET_LED', guardAlerts: true, guardCooldownSec: 30 }
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const kinds = (held: ReturnType<typeof hostState>) => (ledger(held).alerts ?? []).map(a => a.kind)
const releaseTask = async ($: Engine) => {
  await start($)
  await prompt($, 'Please approve the release of v0.5.2 after checking everything')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  for (const g of GATE_NAMES) await progress($, { action: 'gate', gate: g, state: 'na', evidence: 'fixture' })
}
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>

describe('an open mandatory review', () => {
  test('is told to the owner once at stop, and stays open', { options: OPTS }, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($)
    expect(kinds(held)).toEqual([])
    await stop($); await stop($)
    expect(kinds(held)).toEqual(['review-hold'])
    expect(task(held).review).toMatchObject({ grounds: ['release'], state: 'required' })
    expect(task(held).percent).toBeLessThan(100)
  })
  test('acknowledging or silencing the alert does not touch the review', { options: OPTS }, async ($, on) => {
    world(on); const held = hostState(on, {}); await releaseTask($); await stop($)
    const before = JSON.stringify(task(held).review)
    await command($, 'guard ack'); await command($, 'guard silence')
    expect(JSON.stringify(task(held).review)).toBe(before)
    expect(task(held).percent).toBeLessThan(100)
  })
  test('a passing Stop-guard check sets TEST and nothing else: the review and release stay open', { options: { ...OPTS, stopGuard: 'ENFORCE', verifyScript: SCRIPT } }, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const held = hostState(on, {}); await releaseTask($); await enroll($)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => r[0] === SCRIPT)).toBe(true)
    expect(task(held).review).toMatchObject({ grounds: ['release'], state: 'required' })
    expect(task(held).review?.cleared).toBeUndefined()
    expect(task(held).percent).toBeLessThan(100)
  })
})

describe('a release NO-GO', () => {
  const NOGO = { 'release-reviews': [{ candidate: A, id: 'opus-1-aaaaaa', at: 1, returned: true, verified: 'pass', outcome: 'no-go' }] }
  test('alerts once, and the hold is not lifted', { options: OPTS }, async ($, on) => {
    world(on, {}, NOGO); const held = hostState(on, {}); await releaseTask($)
    await progress($, { action: 'status' }); await progress($, { action: 'status' })
    expect(kinds(held)).toEqual(['release-no-go'])
    expect(task(held).review).toMatchObject({ state: 'required' })
    expect(task(held).review?.cleared).toBeUndefined()
  })
})

describe('restart', () => {
  test('the same task, found again after a restart, does not repeat an alert that was written', { options: OPTS }, async ($, on) => {
    let t = newTask(1, 'goal', 100, null)
    t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task
    t = setGate(t, 'SECURITY', 'fail', 'synthetic', 'model', 102)
    const kept: AlertRecord = { key: `${t.id}@${t.startedAt}:security-failure:SECURITY`, kind: 'security-failure', taskId: 1, at: 1, outcome: 'sent', attempts: 1, channel: 'kitty' }
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [kept] } })
    on('session.id', () => ({ value: 's1' }))
    const held = hostState(on, { task: t })
    await start($); await progress($, { action: 'status' })
    expect(w.notified).toEqual([])
    expect((ledger(held).alerts ?? []).filter(a => a.kind === 'security-failure')).toHaveLength(1)
    expect(task(held).gates.SECURITY.state).toBe('fail')
  })
})

describe('script trust and configuration', () => {
  test('the script is only ever the owner\'s configured path, never text from the task', { options: { orchestration: true, stopGuard: 'ENFORCE', verifyScript: 'relative/check.sh' } }, async ($, on) => {
    const w = world(on); w.files['relative/check.sh'] = 'exit 0'; w.players['relative/check.sh'] = 'ok'
    await start($); await progress($, { action: 'plan', milestones: FIVE })
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => (r[0] ?? '').includes('check.sh'))).toBe(false)
  })
  test('a check is run as an argv of exactly one element, with no shell', { options: { orchestration: true, stopGuard: 'ENFORCE', verifyScript: SCRIPT } }, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    await start($); await progress($, { action: 'plan', milestones: FIVE }); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r.includes(SCRIPT))).toEqual([[SCRIPT]])
    expect(w.runs.some(r => ['sh', 'bash', '-c'].includes(r[0] ?? ''))).toBe(false)
  })
})
