// The optional Stop-hook verification guard: OFF unless asked, real exit codes only, enrolled scripts only, bounded, never a loop.

import { describe, expect, test } from 'claude-code/testing'
import { exhaustedBlocker } from '../hooks/alerts'
import { attemptsOf, configOf, hasChangeSummary, scriptPathOf, validChecks, verdictOf } from '../hooks/stopguard'
import type { CheckRecord } from '../hooks/stopguard'
import { command, hostState, planAndComplete, progress, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, ...extra } })
const stop = ($: any, over: Record<string, unknown> = {}) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY, ...over }) as Promise<{ block?: string }>
const rec = (over: Partial<CheckRecord>): CheckRecord => ({ taskId: 1, uid: '1@0', verifier: 'v', complete: false, name: 'check.sh', sha: 'abcd1234', at: 1, outcome: 'fail', exit: 1, ms: 5, tree: null, summary: 'boom', hasSummary: true, ...over })
/** A person reviews the script and enrolls exactly its bytes, as the command asks. */
const enroll = async ($: any): Promise<string> => {
  const shown = String((await command($, 'guard trust')).text)
  const sha = /sha-256  ([0-9a-f]{64})/.exec(shown)![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)

  return sha
}
const runs = (w: { runs: string[][] }) => w.runs.filter(r => r[0] === SCRIPT).length
const armed = async ($: any, on: any, behavior: 'ok' | 'fails' | 'hangs' = 'ok', seed: Record<string, unknown> = {}) => {
  const w = world(on, {}, seed); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = behavior
  const held = hostState(on, {})
  await start($); await planAndComplete($, 1); await enroll($)

  return { w, held }
}

describe('configuration and policy', () => {
  test('OBSERVE is the default and ENFORCE without a script has a stated problem', () => {
    expect(configOf({}, null).policy).toBe('OBSERVE')
    expect(configOf({ stopGuard: 'ENFORCE' }, null).problems.join()).toContain('verifyScript')
  })
  test('paths must be absolute and free of traversal; limits are clamped', () => {
    expect(scriptPathOf('rel/check.sh', null)).toBeNull()
    expect(scriptPathOf('/a/../b.sh', null)).toBeNull()
    expect(scriptPathOf('~/c.sh', '/home/u')).toBe('/home/u/c.sh')
    const c = configOf({ stopGuard: 'ENFORCE', verifyScript: SCRIPT, verifyTimeoutSec: 99999, stopMaxContinuations: 99 }, null)
    expect([c.timeoutMs, c.maxAttempts]).toEqual([900_000, 10])
  })
  test('a summary is required only when the host gave a closing message', () => {
    expect(hasChangeSummary(undefined)).toBe(true)
    expect(hasChangeSummary('Done.')).toBe(false)
    expect(hasChangeSummary(SUMMARY)).toBe(true)
  })
  const cfg = configOf({ stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 2 }, null)
  test('a failure blocks with the reason until the budget is spent, then BLOCKED and allowed', () => {
    expect(verdictOf({ cfg, spent: 0, run: rec({}), hasSummary: true }).action).toBe('block')
    expect(verdictOf({ cfg, spent: 1, run: rec({}), hasSummary: true })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })
  test('a pass without a summary is an attempt: it cannot reset the budget', () => {
    const pass = rec({ outcome: 'pass', exit: 0, complete: false })
    expect(attemptsOf([pass, pass], '1@0')).toBe(2)
    expect(attemptsOf([pass, rec({ outcome: 'pass', exit: 0, complete: true }), pass], '1@0')).toBe(1)
    expect(verdictOf({ cfg, spent: 1, run: pass, hasSummary: false })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })
  test('missing, untrusted, unstable-at-the-end and errors never block the stop', () => {
    for (const outcome of ['missing', 'untrusted', 'error'] as const) expect(verdictOf({ cfg, spent: 0, run: rec({ outcome, exit: null }), hasSummary: true })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
    expect(verdictOf({ cfg, spent: 0, run: rec({ outcome: 'unstable' }), hasSummary: true }).action).toBe('block')
    expect(verdictOf({ cfg, spent: 1, run: rec({ outcome: 'unstable' }), hasSummary: true })).toMatchObject({ action: 'allow', state: 'BLOCKED' })
  })
  test('malformed stored check records are dropped, never believed', () => {
    expect(validChecks([rec({}), { outcome: 'pass' }, null, 'x', { ...rec({}), outcome: 'verified' }, { ...rec({}), exit: 'zero' }])).toHaveLength(1)
    expect(validChecks('not a list')).toEqual([])
  })
  test('what the alert says about a blocked stop', () => {
    expect(exhaustedBlocker('the configured check script is missing or not runnable')).toBeNull()
    expect(exhaustedBlocker('check exit 3 after 2 attempts')).not.toBeNull()
  })
})

describe('the hook', () => {
  test('OBSERVE: no process is run and the stop is not blocked', async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('ENFORCE pass: allowed, TEST passed, the script run as one argv element', guard(), async ($, on) => {
    const { w, held } = await armed($, on)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.filter(r => r[0] === SCRIPT || r[0] === 'sh' || r[0] === 'bash')).toEqual([[SCRIPT]])
    expect((held.get('task')!.value as any).gates.TEST.state).toBe('pass')
  })
  test('fail then repair: blocked with the reason, then allowed; other gates stay independent', guard(), async ($, on) => {
    const { w, held } = await armed($, on, 'fails')
    expect((await stop($)).block).toContain('failed with exit code 1')
    w.players[SCRIPT] = 'ok'
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    const gates = (held.get('task')!.value as any).gates
    expect(gates.TEST.state).toBe('pass')
    for (const other of ['CODE', 'TYPE', 'BUILD', 'SECURITY', 'GIT']) expect(gates[other].state).not.toBe('pass')
  })
  test('a passing check with no summary is bounded: six stops, a budget of two, then allowed and held', guard({ stopMaxContinuations: 2 }), async ($, on) => {
    const { w, held } = await armed($, on)
    const blocked: boolean[] = []
    for (let i = 0; i < 6; i++) blocked.push((await stop($, { stop_hook_active: true, last_assistant_message: 'Done.' })).block !== undefined)
    expect(blocked).toEqual([true, false, false, false, false, false])
    expect(runs(w)).toBe(2)
    const task = held.get('task')!.value as any
    expect(task.stopHold?.reason).toBeDefined()
    expect(task.status).toBe('blocked')
    expect(task.percent).toBeLessThan(100)
  })
  test('a missing summary is repaired by giving one: the check then completes', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    await armed($, on)
    expect((await stop($, { last_assistant_message: 'Done.' })).block).toContain('summarize what you changed')
    expect((await stop($)).block).toBeUndefined()
  })
  test('the budget survives a resumed session', guard({ stopMaxContinuations: 1 }), async ($, on) => {
    const w = world(on, {}, {}); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    hostState(on, {})
    on('session.id', () => ({ value: 's1' }))
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($)
    const before = runs(w)
    await stop($); await stop($)
    expect(runs(w)).toBe(before)
  })
  test('persistent failure: bounded attempts, then allowed and the task is held, never DONE', guard({ stopMaxContinuations: 2 }), async ($, on) => {
    const { w, held } = await armed($, on, 'fails')
    expect((await stop($)).block).toBeDefined()
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    const n = runs(w)
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(runs(w)).toBe(n)
    expect((held.get('task')!.value as any).status).toBe('blocked')
  })
  test('a missing script allows the stop without running anything', guard(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('a run that used its whole timeout counts as a failure', guard({ verifyTimeoutSec: 5 }), async ($, on) => {
    const { w } = await armed($, on, 'fails')
    w.duringRun = async argv => { if (argv[0] === SCRIPT) await w.clock.advance(5_000) }
    expect((await stop($)).block).toContain('did not finish within 5s')
  })
  test('a process that cannot be started is final: allowed, not retried', guard(), async ($, on) => {
    const { w } = await armed($, on, 'hangs')
    expect((await stop($)).block).toBeUndefined()
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(runs(w)).toBe(1)
  })
  test('no task, no check', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'x'; w.players[SCRIPT] = 'fails'
    await start($)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('changes no tool hook saw still call for a check when the repository is dirty', guard(), async ($, on) => {
    const w = world(on, { gitStatus: '# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/x.ts\n' }); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'fails'
    hostState(on, {})
    await start($); await prompt($, 'Please tidy the repository'); await enroll($)
    await stop($)
    expect(runs(w)).toBe(1)
  })
  test('doctor reports the guard and writes no settings', guard(), async ($, on) => {
    const { w } = await armed($, on)
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('STOP-HOOK VERIFICATION GUARD')
    expect(out).toContain('trust: enrolled')
    expect(Object.keys(w.files).some(f => f.endsWith('settings.json'))).toBe(false)
  })
})

describe('script trust', () => {
  test('a configured path alone is not trusted: nothing runs until a person enrolls it', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('trust command: showing the identity enrolls nothing; the typed hash enrolls exactly those bytes', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($)
    const shown = String((await command($, 'guard trust')).text)
    expect(shown).toMatch(/sha-256  [0-9a-f]{64}/)
    expect(shown).toContain('is not authorization')
    expect(String((await command($, 'guard trust 000000000000')).text)).toContain('review this script yourself')
    expect(String((await command($, 'doctor')).text)).toContain('trust: not enrolled')
    await enroll($)
    expect(String((await command($, 'doctor')).text)).toContain('trust: enrolled')
  })
  test('a plugin, a trigger or an unknown origin cannot enroll or remove trust', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1)
    const shown = String((await command($, 'guard trust')).text)
    const sha = /sha-256  ([0-9a-f]{64})/.exec(shown)![1]!
    for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'trigger' }, { kind: 'peer' }, { kind: 'mystery' }]) {
      const out = String((await $.command.run({ command: 'cockpit', args: `guard trust ${sha.slice(0, 12)}`, origin, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
      expect(out).toContain('only by a command you type')
    }
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('the script changed within the session is not run', guard(), async ($, on) => {
    const { w } = await armed($, on)
    w.files[SCRIPT] = 'exit 0 # edited by the agent'
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  const shaOf = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
  const seeded = async (text: string) => ({ 'stop-trust': { [`/work/example\0${SCRIPT}`]: { sha: await shaOf('exit 0'), at: 1 } }, _text: text })
  test('trust survives a restart: a new world on the same store runs the enrolled bytes', guard(), async ($, on) => {
    const { _text, ...store } = await seeded('exit 0')
    const w = world(on, {}, store); w.files[SCRIPT] = _text; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1)
    await stop($)
    expect(runs(w)).toBe(1)
  })
  test('a script changed across the restart is untrusted and not run', guard(), async ($, on) => {
    const { _text, ...store } = await seeded('exit 0')
    const w = world(on, {}, store); w.files[SCRIPT] = 'exit 0 # edited meanwhile'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('bytes, not decoded text, are what is trusted', guard(), async ($, on) => {
    const { w } = await armed($, on)
    w.files[SCRIPT] = 'exit 0 '
    await stop($)
    expect(runs(w)).toBe(0)
  })
  test('trust is per project', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    w.cwd = '/work/another-project'
    await stop($)
    expect(runs(w)).toBe(0)
  })
  test('a pin is checked on top of enrollment, and a pin alone never enrolls', guard({ verifyScriptSha256: '0'.repeat(64) }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'; hostState(on, {})
    await start($); await planAndComplete($, 1)
    const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
    expect(String((await command($, `guard trust ${sha.slice(0, 12)}`)).text)).toContain('does not match verifyScriptSha256')
    await stop($)
    expect(runs(w)).toBe(0)
  })
})

describe('completion integrity', () => {
  test('files changing while the check runs are not verification', guard(), async ($, on) => {
    const { w, held } = await armed($, on)
    let n = 0
    w.duringRun = argv => { if (argv[0] === SCRIPT) w.tree['src/new.ts'] = `changed during the check ${++n}` }
    const out = await stop($)
    expect(out.block).toContain('Files changed while')
    expect((held.get('task')!.value as any).gates.TEST.state).not.toBe('pass')
  })
  test('a check that only leaves artifacts behind is run once more and then counts', guard(), async ($, on) => {
    const { w } = await armed($, on)
    let first = true
    w.duringRun = argv => { if (argv[0] === SCRIPT && first) { first = false; w.tree['__pycache__/x.pyc'] = 'artifact' } }
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(2)
  })
  test('a held task cannot be released or re-passed through the progress tool', guard({ stopMaxContinuations: 1 }), async ($, on) => {
    const { held } = await armed($, on, 'fails')
    await stop($)
    expect((held.get('task')!.value as any).stopHold).toBeDefined()
    for (const input of [{ action: 'unblock' }, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'I ran the tests myself' }, { action: 'gate', gate: 'TEST', state: 'pending' }, { action: 'block', milestone: 'm2', note: 'something else' }, { action: 'gates', gates: [{ gate: 'TEST', state: 'na', evidence: 'x' }] }]) {
      expect(await progress($, input)).toContain('STOP GUARD')
    }
    const task = held.get('task')!.value as any
    expect(task.stopHold).toBeDefined()
    expect(task.gates.TEST.state).toBe('fail')
    expect(task.status).toBe('blocked')
  })
  test('a reset then a new task does not inherit the old verdict or budget', guard({ stopMaxContinuations: 1 }), async ($, on) => {
    const { w } = await armed($, on, 'fails')
    await stop($)
    const first = runs(w)
    await command($, 'reset')
    await w.clock.advance(1000)
    await progress($, { action: 'plan', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    await stop($)
    expect(runs(w)).toBe(first + 1)
  })
})

describe('ENFORCE does not fail open', () => {
  const DIRTY = '# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/x.ts\n'
  const scripted = (on: any, status: string | null = DIRTY) => {
    const w = world(on, status === null ? {} : { gitStatus: status }); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'fails'
    const held = hostState(on, {})

    return { w, held }
  }
  test('F1: files edited with no prompt and no plan still call for the check', guard(), async ($, on) => {
    const { w } = scripted(on)
    await start($); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('F1: a dirty repository with no task at all calls for the check', guard(), async ($, on) => {
    const { w } = scripted(on)
    await start($); await enroll($)
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('F1: a reset task followed by edits calls for the check', guard(), async ($, on) => {
    const { w } = scripted(on)
    await start($); await prompt($, 'Please tidy the repository'); await enroll($)
    await command($, 'reset')
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('F1: no task and a clean repository needs no check', guard(), async ($, on) => {
    const { w } = scripted(on, null)
    await start($)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  for (const bad of ['enforce', 'Enforce ', 'ENFORCED', 'true', 'on', 1, true]) {
    test(`F4: stopGuard ${JSON.stringify(bad)} is not silently OBSERVE`, async ($, on) => {
      const c = configOf({ stopGuard: bad, verifyScript: SCRIPT }, null)
      expect(c.policy).toBe('ENFORCE')
      expect(c.problems.join()).toContain('stopGuard')
    })
  }
  test('F4: OBSERVE and absent stay OBSERVE with no problem', async () => {
    for (const v of [undefined, 'OBSERVE', '']) expect(configOf({ stopGuard: v }, null)).toMatchObject({ policy: 'OBSERVE', problems: [] })
  })
  test('F4: ENFORCE with a malformed verifyScript refuses the stop once, then allows (bounded)', guard({ verifyScript: '../relative.sh' }), async ($, on) => {
    const { w } = scripted(on)
    await start($); await prompt($, 'Please tidy the repository')
    const first = await stop($)
    expect(first.block).toContain('STOP GUARD')
    expect(first.block).toContain('verifyScript')
    expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('F4: a malformed pin refuses the stop once', guard({ verifyScriptSha256: 'abc' }), async ($, on) => {
    scripted(on)
    await start($); await prompt($, 'Please tidy the repository')
    expect((await stop($)).block).toContain('verifyScriptSha256')
  })
})
