// The optional Stop-hook verification guard: OFF unless asked, real exit codes only, bounded, never a loop.

import { describe, expect, test } from 'claude-code/testing'
import { attemptsOf, configOf, scriptPathOf, verdictOf } from '../hooks/stopguard'
import type { CheckRecord } from '../hooks/stopguard'
import { command, planAndComplete, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, ...extra } })
const stop = ($: any, over: Record<string, unknown> = {}) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY, ...over }) as Promise<{ block?: string }>
const rec = (over: Partial<CheckRecord>): CheckRecord => ({ taskId: 1, name: 'check.sh', sha: 'abcd1234', at: 1, outcome: 'fail', exit: 1, ms: 5, tree: null, summary: 'boom', hasSummary: true, ...over })

describe('configuration', () => {
  test('OBSERVE is the default and ENFORCE without a script has a stated problem', () => {
    expect(configOf({}, null).policy).toBe('OBSERVE')
    const c = configOf({ stopGuard: 'ENFORCE' }, null)
    expect(c.problems.join()).toContain('verifyScript')
  })
  test('paths must be absolute and free of traversal; limits are clamped', () => {
    expect(scriptPathOf('rel/check.sh', null)).toBeNull()
    expect(scriptPathOf('/a/../b.sh', null)).toBeNull()
    expect(scriptPathOf('~/c.sh', '/home/u')).toBe('/home/u/c.sh')
    const c = configOf({ stopGuard: 'ENFORCE', verifyScript: SCRIPT, verifyTimeoutSec: 99999, stopMaxContinuations: 99 }, null)
    expect([c.timeoutMs, c.maxAttempts]).toEqual([900_000, 10])
    expect(configOf({ verifyScriptSha256: 'zz' }, null).pin).toBeNull()
  })
})

describe('verdicts', () => {
  const cfg = configOf({ stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 2 }, null)
  test('a failure blocks with the reason until the budget is spent, then BLOCKED and allowed', () => {
    expect(verdictOf({ cfg, spent: 0, run: rec({}), hasSummary: true }).action).toBe('block')
    const last = verdictOf({ cfg, spent: 1, run: rec({}), hasSummary: true })
    expect(last).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })
  test('missing, untrusted and errors never block the stop', () => {
    for (const outcome of ['missing', 'untrusted', 'error'] as const) expect(verdictOf({ cfg, spent: 0, run: rec({ outcome, exit: null }), hasSummary: true })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })
  test('attempts count failures since the last pass', () => {
    expect(attemptsOf([rec({}), rec({ outcome: 'pass', exit: 0 }), rec({}), rec({ outcome: 'timeout', exit: null })], 1)).toBe(2)
  })
})

describe('the hook', () => {
  test('OBSERVE: no process is run and the stop is not blocked', async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => r[0] === SCRIPT)).toBe(false)
  })
  test('ENFORCE pass: allowed, and the TEST gate is passed', { ...guard() }, async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.filter(r => r[0] === SCRIPT)).toEqual([[SCRIPT]])
  })
  test('ENFORCE fail then repair: blocked with the reason, then allowed', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1)
    const first = await stop($)
    expect(first.block).toContain('failed with exit code 1')
    w.players[SCRIPT] = 'ok'
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  })
  test('persistent failure: bounded attempts, then the stop is allowed and the task is blocked', guard({ stopMaxContinuations: 2 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeDefined()
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    const runs = w.runs.filter(r => r[0] === SCRIPT).length
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(runs)
  })
  test('a missing script allows the stop without retrying', guard(), async ($, on) => {
    const w = world(on)
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => r[0] === SCRIPT)).toBe(false)
  })
  test('a script changed during the session is untrusted and is not run', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    await start($); await planAndComplete($, 1)
    w.files[SCRIPT] = 'exit 0 # edited by the agent'
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => r[0] === SCRIPT)).toBe(false)
  })
  test('a run that used its whole timeout counts as a failure', guard({ verifyTimeoutSec: 5 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    w.duringRun = async argv => { if (argv[0] === SCRIPT) await w.clock.advance(5_000) }
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toContain('did not finish within 5s')
  })
  test('a process that cannot be started is final: allowed, not retried', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'hangs'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
  })
  test('a denied process is final: allowed, no second route', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
  })
  test('no task, no check', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.some(r => r[0] === SCRIPT)).toBe(false)
  })
  test('doctor reports the guard and writes no settings', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'
    await start($)
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('STOP-HOOK VERIFICATION GUARD')
    expect(out).toContain('ENFORCE · script check.sh')
    expect(Object.keys(w.files).some(f => f.endsWith('settings.json'))).toBe(false)
  })
})
