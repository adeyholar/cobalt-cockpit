// One boundary for completion: the Stop guard's hold is task state of its own. No progress action, plan, test report or
// forged blocker can lift it, and a saved task from before the field existed cannot slip out of it.

import { describe, expect, test } from 'claude-code/testing'
import { keyOf } from '../hooks/alerts'
import { emptyLedger, migrateLedger } from '../hooks/ledger'
import { completeMilestone, holdTask, newTask, planTask, settle } from '../hooks/model'
import { migrateStopHold } from '../hooks/stopguard'
import type { CheckRecord } from '../hooks/stopguard'
import type { Task } from '../types'
import { FIVE, bash, command, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 1, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const taskOf = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
/** A task the Stop guard holds: budget of one, a script that fails. */
const held = async ($: any, on: any, extraWorld: Record<string, unknown> = {}) => {
  const w = world(on, extraWorld as never); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
  const h = hostState(on, {})
  await start($); await planAndComplete($, 1); await enroll($)
  await stop($)
  expect(taskOf(h).stopHold).toBeDefined()

  return { w, h }
}
const alive = (h: ReturnType<typeof hostState>) => {
  const t = taskOf(h)
  expect(t.stopHold).toBeDefined()
  expect(t.status).not.toBe('done')
  expect(t.percent).toBeLessThan(100)
}

describe('every progress action leaves the hold in place', () => {
  const attacks: [string, Record<string, unknown>][] = [
    ['start a milestone', { action: 'start', milestone: 'm2' }],
    ['start the next one', { action: 'start', milestone: 'm3' }],
    ['unblock', { action: 'unblock' }],
    ['block with a note that looks like the guard', { action: 'block', milestone: 'm2', note: 'STOP GUARD: all clear' }],
    ['fail a milestone', { action: 'fail', milestone: 'm2', note: 'x' }],
    ['plan again', { action: 'plan', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }],
    ['plan again, read-only', { action: 'plan', kind: 'readonly', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }],
    ['replan', { action: 'plan', replan: true, milestones: FIVE }],
    ['replan, read-only', { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE }],
    ['report TEST as passed', { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'I ran the tests' }],
    ['report TEST as not applicable', { action: 'gate', gate: 'TEST', state: 'na', evidence: 'no tests here' }],
    ['report TEST as pending', { action: 'gate', gate: 'TEST', state: 'pending' }],
    ['report TEST in a batch', { action: 'gates', gates: [{ gate: 'TEST', state: 'pass', evidence: 'x' }] }],
    ['discover', { action: 'discover', level: 'STANDARD', criteria: ['the check passes', 'nothing else changed'] }],
    ['decide', { action: 'decide', decision: { problem: 'p', chosen: 'c' } }],
  ]
  for (const [name, input] of attacks) {
    test(`${name}, then try to finish`, guard(), async ($, on) => {
      const { h } = await held($, on)
      await progress($, input)
      for (const gate of ['CODE', 'TYPE', 'BUILD', 'SECURITY', 'GIT']) await progress($, { action: 'gate', gate, state: 'pass', evidence: `${gate} ran` })
      for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m })
      await progress($, { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: 'x' }] } })
      alive(h)
    })
  }
  test('the 6438510 exploit: spend the budget, start a milestone, report TEST, reach for DONE', guard(), async ($, on) => {
    const { h } = await held($, on)
    await progress($, { action: 'start', milestone: 'm2' })
    expect(await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran tests' })).toContain('STOP GUARD hold')
    await progress($, { action: 'complete', milestone: 'm5' })
    alive(h)
    expect(taskOf(h).gates.TEST.state).toBe('fail')
    // the next stop does not run the check again either: the budget stays spent
    expect((await stop($)).block).toBeUndefined()
    alive(h)
  })
  test('a test command that passes cannot lift or replace the hold', guard(), async ($, on) => {
    const { h } = await held($, on)
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).toBe('fail')
    alive(h)
  })
  test('a held task cannot be re-declared read-only to shed TEST', guard(), async ($, on) => {
    const { h } = await held($, on)
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).gates.TEST.isRequired).toBe(true)
  })
})

describe('only a person lifts the hold, and it passes nothing', () => {
  test('release by a person: hold gone, TEST pending, budget starts over, a check can run again', guard(), async ($, on) => {
    const { w, h } = await held($, on)
    const text = String((await command($, 'guard release')).text)
    expect(text).toContain('released')
    const t = taskOf(h)
    expect(t.stopHold).toBeUndefined()
    expect(t.gates.TEST.state).toBe('pending')
    expect(t.status).not.toBe('done')
    const before = w.runs.filter(r => r[0] === SCRIPT).length
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(before + 1)
  })
  test('a plugin, a trigger or an unknown origin cannot release it', guard(), async ($, on) => {
    const { h } = await held($, on)
    for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'trigger' }, { kind: 'mystery' }]) {
      const out = String((await $.command.run({ command: 'cockpit', args: 'guard release', origin, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
      expect(out).toContain('only by a command you type')
    }
    alive(h)
  })
  test('reset is the explicit new task: it carries nothing', guard(), async ($, on) => {
    const { w, h } = await held($, on)
    await command($, 'reset'); await w.clock.advance(1000)
    await progress($, { action: 'plan', milestones: FIVE })
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('a plain plan continues the task: hold and identity go with it', guard(), async ($, on) => {
    const { h } = await held($, on)
    const before = taskOf(h)
    await progress($, { action: 'plan', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    expect(taskOf(h).stopHold).toEqual(before.stopHold)
    expect(taskOf(h).lineage).toBeDefined()
  })
})

describe('the model refuses completion on its own, whatever the host layer does', () => {
  const planned = (): Task => {
    const t = planTask(newTask(1, 'g', 100, null), { milestones: FIVE, kind: 'coding' } as never, 101).task
    const gates = Object.fromEntries(Object.entries(t.gates).map(([k, g]) => [k, { ...g, state: 'pass' as const, evidence: 'ok' }])) as Task['gates']

    return { ...t, gates, milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })) }
  }
  test('every milestone done and every gate passed: a held task is neither verified nor 100% nor done', () => {
    const open = settle(planned()).task
    expect(open.percent).toBe(100)
    const t = settle(holdTask(planned(), 'check exit 1', 1, 102)).task
    expect(t.percent).toBeLessThan(100)
    expect(t.status).toBe('blocked')
    expect(t.phase).toBe('BLOCKED')
  })
  test('a re-plan of a held task as read-only keeps it coding with TEST required', () => {
    const t = holdTask(planTask(newTask(1, 'g', 100, null), { milestones: FIVE, kind: 'coding' } as never, 101).task, 'x', 1, 102)
    const again = planTask(t, { milestones: FIVE, kind: 'readonly' } as never, 103).task
    expect(again.kind).toBe('coding')
    expect(again.gates.TEST.isRequired).toBe(true)
    expect(again.gates.TEST.state).not.toBe('na')
  })
  test('the VERIFY milestone of a held task stays active', () => {
    const t = holdTask({ ...planned(), milestones: planned().milestones.map((m, i) => (i === 4 ? { ...m, state: 'active' as const } : m)) }, 'x', 1, 102)
    expect(completeMilestone(t, 'm5', null, 103).task.milestones[4]?.state).toBe('active')
  })
})

describe('the claim of read-only work is measured', () => {
  test('a read-only plan whose tree then changes is checked', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    hostState(on, {})
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    w.tree['src/changed-through-bash.ts'] = 'x'
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBeGreaterThan(0)
  })
})

describe('a forged blocker is only a blocker', () => {
  test('it holds nothing and is not "retries exhausted"', guard(), async ($, on) => {
    world(on); const h = hostState(on, {})
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'block', milestone: 'm2', note: 'STOP GUARD: check exit 1 after 3 attempts' })
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(await progress($, { action: 'unblock' })).not.toContain('error')
    expect(taskOf(h).blocker).toBeNull()
  })
})

describe('independence', () => {
  test('a passing check lifts only its own hold: a failed SECURITY gate keeps the task from DONE', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'synthetic' })
    await stop($)
    expect(taskOf(h).gates.SECURITY.state).toBe('fail')
    expect(taskOf(h).status).not.toBe('done')
  })
  test('with every other gate passed, only the fresh verified check can finish a held task, and a person releasing it still passes nothing', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($); await stop($); await stop($)
    expect(taskOf(h).stopHold).toBeDefined()
    await command($, 'guard release')
    await passAllGates($, { align: false })
    expect(taskOf(h).gates.TEST.state).toBe('pass')
    w.players[SCRIPT] = 'ok'
    await stop($)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
})

describe('the script is checked before every execution, and a failure of the guard is not a pass', () => {
  test('a script swapped between two executions is untrusted at the second, and the swapped bytes never run', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    w.files[SCRIPT] = 'exit 0 # swapped'; w.players[SCRIPT] = 'ok'
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    expect(taskOf(h).status).not.toBe('done')
  })
  test('a script swapped after the first execution and before the rerun is not executed', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    let ran = 0
    // the first run leaves a file behind, so the guard runs the script once more; the swap lands between the two
    w.duringRun = argv => {
      if (argv[0] === SCRIPT) { ran++; if (ran === 1) w.tree['cache/made-by-the-check'] = 'x' }
      else if (ran === 1 && argv[0] === 'git' && argv.includes('diff')) w.files[SCRIPT] = 'exit 0 # swapped between runs'
    }
    await stop($)
    expect(ran).toBe(1)
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
  })
  test('a script swapped while it ran: its result is untrusted, never a pass', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    w.duringRun = argv => { if (argv[0] === SCRIPT) w.files[SCRIPT] = 'exit 0 # swapped during the run' }
    await stop($)
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    expect(taskOf(h).status).not.toBe('done')
  })
  test('an exception inside the guard holds the task: it is never a silent pass', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    // a malformed host payload makes the guard raise before it checks anything
    const out = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 42 } as never) as { block?: string }
    expect(out.block).toBeUndefined()
    const t = taskOf(h)
    expect(t.stopHold?.reason).toContain('raised an error')
    expect(t.gates.TEST.state).not.toBe('pass')
    expect(t.status).toBe('blocked')
  })
  test('an error in the middle of a check is a held task, not a pass', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    w.duringRun = () => { throw new Error('the host fell over') }
    await stop($)
    w.duringRun = null
    const t = taskOf(h)
    expect(t.gates.TEST.state).not.toBe('pass')
    expect(t.status).not.toBe('done')
    expect(t.percent).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
// A task saved before the hold was a field of its own.
// ---------------------------------------------------------------------------

const legacy = (over: Partial<Task> = {}): Task => {
  const { guardSchema: _s, ...rest } = newTask(1, 'goal', 100, null)

  return { ...rest, kind: 'coding', ...over } as Task
}
const UID = '1@100'
const rec = (over: Partial<CheckRecord>): CheckRecord => ({ taskId: 1, uid: UID, verifier: 'v', complete: false, name: 'check.sh', sha: 'abcd1234', at: 1, outcome: 'fail', exit: 1, ms: 5, tree: null, summary: 'boom', hasSummary: true, ...over })
const migrate = (t: Task, checks: CheckRecord[], dropped = 0) => migrateStopHold(t, checks, dropped, 3, 500)

describe('migration of saved tasks', () => {
  test('a legacy held task (guard blocker and an unfinished record) stays held', () => {
    const t = migrate(legacy({ blocker: 'STOP GUARD: check exit 1 after 3 attempts' }), [rec({}), rec({}), rec({})])
    expect(t.stopHold?.reason).toContain('check exit 1 after 3 attempts')
    expect(t.guardSchema).toBe(1)
  })
  test('an exhausted budget stays held even when the model cleared the blocker', () => {
    expect(migrate(legacy(), [rec({}), rec({}), rec({})]).stopHold).toBeDefined()
  })
  test('a check that could not run stays held', () => {
    expect(migrate(legacy(), [rec({ outcome: 'untrusted', exit: null })]).stopHold?.reason).toContain('untrusted')
  })
  test('a legacy pass with no summary, budget not spent: no hold, the budget is kept by the records', () => {
    const t = migrate(legacy(), [rec({ outcome: 'pass', exit: 0 })])
    expect(t.stopHold).toBeUndefined()
  })
  test('a guard blocker whose checks all completed is ambiguous: held, never granted', () => {
    const t = migrate(legacy({ blocker: 'STOP GUARD: all fine' }), [rec({ outcome: 'pass', exit: 0, complete: true })])
    expect(t.stopHold?.reason).toContain('ambiguous')
  })
  test('unreadable records with a guard-looking blocker exhaust the unknown allowance', () => {
    const migrated = migrate(legacy({ blocker: 'STOP GUARD: x' }), [], 2)
    expect(migrated.stopHold?.reason).toContain('could not be read')
    expect(migrated.stopHold?.refusals).toBe(10)
  })
  test('a forged guard blocker with no record at all is an ordinary blocker', () => {
    const t = migrate(legacy({ blocker: 'STOP GUARD: check exit 1 after 3 attempts' }), [])
    expect(t.stopHold).toBeUndefined()
    expect(t.blocker).toContain('STOP GUARD')
  })
  test('an ordinary blocker, a failed TEST gate, an OBSERVE task and a completed task are untouched', () => {
    for (const t of [legacy({ blocker: 'waiting for the owner' }), legacy(), legacy({ status: 'done', percent: 100 })]) {
      const m = migrate(t, [])
      expect(m.stopHold).toBeUndefined()
      expect({ ...m, guardSchema: undefined }).toEqual({ ...t, guardSchema: undefined })
    }
    expect(migrate(legacy(), [rec({ outcome: 'pass', exit: 0, complete: true })]).stopHold).toBeUndefined()
  })
  test('another task\'s records do not hold this one', () => {
    expect(migrate(legacy(), [rec({ uid: '9@9' }), rec({ uid: '9@9' }), rec({ uid: '9@9' })]).stopHold).toBeUndefined()
  })
  test('migration is idempotent and never resets what it settled', () => {
    const once = migrate(legacy({ blocker: 'STOP GUARD: check exit 1' }), [rec({})])
    expect(migrate(once, [])).toBe(once)
    expect(migrate(migrate(once, []), [rec({ complete: true })]).stopHold).toEqual(once.stopHold)
  })
  test('malformed legacy records are dropped, counted, and establish nothing', () => {
    const l = migrateLedger({ ...emptyLedger('s'), stopChecks: [rec({}), { garbage: true }, null] } as never)
    expect(l.stopChecks).toHaveLength(1)
    expect(l.stopDropped).toBe(2)
    expect(migrateLedger(l).stopDropped).toBe(2)
  })
})

describe('migration through the host', () => {
  const saved = (t: Task, checks: CheckRecord[]) => ({ task: t, 'run-ledger': { ...emptyLedger('s1'), stopChecks: checks } })
  test('a legacy held task stays held across plan, start and complete, and a restart', guard(), async ($, on) => {
    world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), stopChecks: [rec({}), rec({}), rec({})] } })
    on('session.id', () => ({ value: 's1' }))
    const h = hostState(on, saved(legacy({ blocker: 'STOP GUARD: check exit 1 after 3 attempts', milestones: FIVE.map((f, i) => ({ id: `m${i + 1}`, title: f.title, phase: 'IMPLEMENT' as const, state: 'pending' as const, note: null })) }), [rec({}), rec({}), rec({})]))
    await start($)
    await progress($, { action: 'start', milestone: 'm2' })
    await progress($, { action: 'plan', milestones: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'x' })
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).status).not.toBe('done')
    await stop($)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  const legacySession = (on: any, w: any, task: Task, checks: CheckRecord[], dropped = 0) => {
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)

    return hostState(on, { task, 'run-ledger': { ...emptyLedger('s1'), stopChecks: checks, stopDropped: dropped } })
  }
  test('a legacy hold with unreadable records needs a person to release it before a fresh check, even on a clean tree', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = legacySession(on, w, legacy({ blocker: 'STOP GUARD: x' }), [], 2)
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    expect(taskOf(h).stopHold?.reason).toContain('could not be read')
    await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold?.refusals).toBe(10)
    await command($, 'guard release')
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('a legacy hold with the script not enrolled runs nothing and grants nothing', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = legacySession(on, w, legacy({ blocker: 'STOP GUARD: x' }), [], 2)
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
  })
  test('a legacy record of another verifier does not let a changed or different script take the task over', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = legacySession(on, w, legacy({ blocker: 'STOP GUARD: x' }), [rec({ outcome: 'fail', verifier: 'someone-else' })])
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
  })
  test('a person can release an ambiguous legacy hold, which passes nothing', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)
    const h = hostState(on, saved(legacy({ blocker: 'STOP GUARD: x' }), [rec({ outcome: 'pass', exit: 0, complete: true })]))
    await start($)
    await $.classic.SessionStart({ source: 'startup' } as never)
    expect(taskOf(h).stopHold?.reason).toContain('ambiguous')
    await command($, 'guard release')
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(taskOf(h).gates.TEST.state).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// H1 (opus-3-1f7a0c): "read-only" is a claim measured against where the task began, not where the claim was made.
// ---------------------------------------------------------------------------

describe('a read-only claim is measured against the start of the task', () => {
  const finish = async ($: any) => {
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m })
  }
  const ranOf = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  test('H1: a file changed by an unobserved route, then a read-only plan, cannot reach DONE without the check', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await prompt($, 'look at the parser')
    await enroll($)
    w.tree['src/changed-by-an-mcp-tool.ts'] = 'x'                                  // no Edit, Write or Bash diff saw this
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finish($)
    await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)                                              // the verifier was not skipped on the model's say-so
    expect(taskOf(h).status).not.toBe('done')
    expect(taskOf(h).percent).toBeLessThan(100)
  })
  test('H1 variant: the same through a re-plan', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await prompt($, 'look at the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/changed-later.ts'] = 'x'
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    await finish($); await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
    expect(taskOf(h).status).not.toBe('done')
  })
  test('genuinely read-only work stays light: nothing changed since the task began, no check runs', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    await finish($); await stop($)
    expect(ranOf(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
})

describe('the baseline policy', () => {
  const plan = ($: any, extra: Record<string, unknown> = {}) => progress($, { action: 'plan', kind: 'readonly', milestones: FIVE, ...extra })
  const finishAll = async ($: any) => { for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m }) }
  const ranOf = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const fixture = (on: any, options?: unknown) => { const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'; return { w, h: hostState(on, {}) } }

  test('an edit the hooks saw makes the read-only claim unprovable, even with an unchanged fingerprint', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    await plan($)
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($); await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
  })
  test('no baseline (no prompt began the task): the claim is not accepted and the answer says why', guard(), async ($, on) => {
    const { h } = fixture(on)
    await start($); await enroll($)
    const out = await plan($)
    expect(taskOf(h).kind).toBe('coding')
    expect(out).toContain('Read-only was not accepted')
  })
  test('no git: the tree is unknown, so the claim is not accepted and the check runs', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await prompt($, 'explain the parser'); await enroll($)
    await plan($)
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($); await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
  })
  test('a second prompt of an unfinished task keeps the first baseline', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    w.tree['src/written-meanwhile.ts'] = 'x'
    await prompt($, 'and the lexer too')
    await plan($)
    expect(taskOf(h).kind).toBe('coding')
  })
  test('the baseline is kept across prompts, so unchanged read-only work stays light', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await prompt($, 'and the lexer too')
    await plan($)
    expect(taskOf(h).kind).toBe('readonly')
    await finishAll($); await stop($)
    expect(ranOf(w)).toBe(0)
  })
  test('a read-only task whose baseline is unknown is checked at the Stop (no git, no fingerprint)', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    on('session.id', () => ({ value: 's2' }))
    const standing = { ...newTask(1, 'goal', 100, null), kind: 'readonly' as const, startTree: null }
    await start($); await enroll($)
    const t = h.get('task'); h.set('task', { value: standing, version: (t?.version ?? 0) + 1 })
    await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
  })
  test('a read-only task whose fingerprint can no longer be taken is checked at the Stop', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await plan($)
    expect(taskOf(h).kind).toBe('readonly')
    w.gitStatus = null                                                  // git stops answering after the declaration
    await finishAll($); await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
  })
  test('a new task after a finished one has its own baseline, and read-only is light again', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await plan($); await finishAll($); await stop($)
    expect(taskOf(h).status).toBe('done')
    await prompt($, 'explain the lexer')                                              // nothing changed between the tasks
    await plan($)
    expect(taskOf(h).id).toBe(2)
    expect(taskOf(h).kind).toBe('readonly')
    await finishAll($); await stop($)
    expect(ranOf(w)).toBe(0)
  })
  test('H-1 (owner decision): work done between tasks is never accepted as the next baseline', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await plan($); await finishAll($); await stop($)
    expect(taskOf(h).status).toBe('done')
    w.tree['src/work-between-tasks.ts'] = 'x'
    await prompt($, 'explain the lexer')
    expect(taskOf(h).id).toBe(1)                                                       // the finished task is held, not left behind
    expect(taskOf(h).stopHold).toBeDefined()
    await plan($)
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($); await stop($)
    expect(ranOf(w)).toBeGreaterThan(0)
  })
  test('without the Stop guard enforcing, the claim is accepted as before', { options: { stopGuard: 'OBSERVE' } }, async ($, on) => {
    const { h } = fixture(on)
    await start($)
    await plan($)
    expect(taskOf(h).kind).toBe('readonly')
  })
  test('the baseline is not model-writable: it is not an input of the progress tool', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    w.tree['src/x.ts'] = 'x'
    await plan($, { startTree: 'forged', baseline: 'forged', planTree: 'forged' })
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).startTree).not.toBe('forged')
  })
})

describe('M1: a prompt is not a reset', () => {
  const heldNoPlan = (on: any) => {
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)

    return hostState(on, { task: legacy({ blocker: 'STOP GUARD: check exit 1 after 3 attempts' }), 'run-ledger': { ...emptyLedger('s1'), stopChecks: [rec({}), rec({}), rec({})] } })
  }
  test('a person\'s prompt on a held task with no milestones continues it: same task, same hold', guard(), async ($, on) => {
    world(on); const h = heldNoPlan(on)
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    const before = taskOf(h)
    expect(before.stopHold).toBeDefined()
    await prompt($, 'something entirely different now')
    const after = taskOf(h)
    expect(after.id).toBe(before.id)
    expect(after.stopHold).toEqual(before.stopHold)
    expect(after.status).toBe('blocked')
  })
  test('/cockpit reset by a person abandons it: nothing passed, nothing done, and the Ledger keeps what it was', guard(), async ($, on) => {
    world(on); const h = heldNoPlan(on)
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    await command($, 'reset')
    expect(h.get('task')?.value ?? null).toBeNull()
    const kept = ((h.get('run-ledger')!.value as { stopChecks: CheckRecord[] }).stopChecks).at(-1)!
    expect(kept.name).toBe('reset')
    expect(kept.outcome).toBe('released')
    expect(kept.summary).toContain('abandoned')
    await prompt($, 'a new job')
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
  })
  test('other origins cannot reset a held task', guard(), async ($, on) => {
    world(on); const h = heldNoPlan(on)
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    const out = String((await $.command.run({ command: 'cockpit', args: 'reset', origin: { kind: 'plugin', name: 'x' }, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
    expect(out).toContain('only by a command you type')
    expect(taskOf(h).stopHold).toBeDefined()
  })
})

describe('M2: a migrated hold does not stand beside DONE', () => {
  const done = (): Task => {
    const t = planTask(newTask(1, 'goal', 100, null), { milestones: FIVE, kind: 'coding' } as never, 101).task
    const { guardSchema: _s, ...rest } = t

    return { ...rest, blocker: 'STOP GUARD: check exit 1 after 3 attempts', status: 'done', percent: 100, phase: 'DONE', milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })), gates: Object.fromEntries(Object.entries(t.gates).map(([k, g]) => [k, { ...g, state: 'pass' as const, evidence: 'ok' }])) as Task['gates'] } as Task
  }
  test('a task saved as DONE / 100% with an unresolved guard hold is blocked after migration, and the next prompt keeps the hold', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)
    const h = hostState(on, { task: done(), 'run-ledger': { ...emptyLedger('s1'), stopChecks: [rec({}), rec({}), rec({})] } })
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    const t = taskOf(h)
    expect(t.stopHold).toBeDefined()
    expect(t.status).toBe('blocked')
    expect(t.percent).toBeLessThan(100)
    await prompt($, 'what is the state?')
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).id).toBe(1)
  })
  test('a legacy task finished before the guard owned completion is held for one check, not trusted', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)
    const finished = { ...done(), blocker: null }
    const h = hostState(on, { task: finished, 'run-ledger': { ...emptyLedger('s1'), stopChecks: [rec({ outcome: 'pass', exit: 0, complete: true })] } })
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    expect(taskOf(h).status).not.toBe('done')                                          // a pass with no tree identity is no completion record
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).percent).toBeLessThan(100)
  })

})

describe('M3: a task carried into a session with an empty Ledger', () => {
  const stored = (checks: CheckRecord[]) => ({ 'stop-checks': { v: 1, checks } })
  const current = (over: Partial<Task> = {}): Task => ({ ...newTask(1, 'goal', 100, null), kind: 'coding', startTree: null, ...over })
  const session = (on: any, task: Task) => {
    on('session.id', () => ({ value: 's2' }))
    on('classic.SessionStart', () => ({}) as never)

    return hostState(on, { task })
  }
  const enrolledWorld = (on: any, checks: CheckRecord[], player: 'fails' | 'ok' = 'fails') => {
    const w = world(on, {}, stored(checks)); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = player

    return w
  }
  test('the spent budget is found again: no more runs, and the task is held', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = enrolledWorld(on, [rec({}), rec({}), rec({})])
    const h = session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).status).not.toBe('done')
  })
  test('a part-spent budget goes on from where it was, not from zero', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const verifier = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`/work/example\0${SCRIPT}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
    const w = enrolledWorld(on, [rec({ verifier }), rec({ verifier })])
    const h = session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('records of another task are not this task\'s budget', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = enrolledWorld(on, [rec({ uid: '9@9' }), rec({ uid: '9@9' }), rec({ uid: '9@9' })])
    session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
  })
  test('a forged or malformed durable record establishes nothing', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on, {}, { 'stop-checks': { v: 1, checks: [{ uid: '1@100', outcome: 'pass', complete: true }, 'x', null] } }); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
  })
  test('a record store of an unknown version is not believed', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on, {}, { 'stop-checks': { v: 2, checks: [rec({}), rec({}), rec({})] } }); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
  })
  test('the verifier a task started with is kept: another script cannot take it over', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = enrolledWorld(on, [rec({ verifier: 'someone-else' })], 'ok')
    const h = session(on, current())
    await start($); await $.classic.SessionStart({ source: 'startup' } as never); await enroll($)
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
  })
  test('the records are written to the durable key as well as the Ledger', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($)
    expect(w.storeWrites.some((k: any) => String(k?.key ?? k).includes('stop-checks'))).toBe(true)
    expect(taskOf(h).stopHold?.refusals).toBe(1)                                         // held from the first failed check
  })
})

describe('small fixes', () => {
  test('L1: a release before any check does not lock the task out of its own verifier', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await start($); await planAndComplete($, 1); await enroll($)
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 42 } as never)   // the guard raises: held with no record
    expect(taskOf(h).stopHold).toBeDefined()
    await command($, 'guard release')
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    expect(taskOf(h).gates.TEST.state).toBe('pass')
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('L2: a task whose last check could not run is held even if the hold was missing', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on, {}, { 'stop-checks': { v: 1, checks: [rec({ outcome: 'untrusted', exit: null })] } }); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    on('session.id', () => ({ value: 's2' }))
    on('classic.SessionStart', () => ({}) as never)
    const h = hostState(on, { task: { ...newTask(1, 'goal', 100, null), kind: 'coding', startTree: null } })
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    await stop($)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(0)
  })
  test('alert identity survives task-number reuse: two tasks numbered 1 do not share a key', () => {
    expect(keyOf('1@100', 'security-failure', 'SECURITY')).not.toBe(keyOf('1@900', 'security-failure', 'SECURITY'))
  })
})

describe('each protection is shown on its own, with the others out of the way', () => {
  const asHeld = (extra: Partial<Task> = {}) => legacy({ blocker: 'STOP GUARD: check exit 1 after 3 attempts', ...extra })
  const ledgerOf = (checks: CheckRecord[]) => ({ ...emptyLedger('s1'), stopChecks: checks })

  test('a legacy hold is in force for the first Bash test result, before anything else touched the task', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    const h = hostState(on, { task: { ...asHeld(), kind: 'coding' }, 'run-ledger': ledgerOf([rec({}), rec({}), rec({})]) })
    await start($)                       // no SessionStart, no progress call, no Stop: the Bash result is the first thing to arrive
    await bash($, 'npm test')
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('planning again keeps TEST required on a held task whose TEST was marked not applicable', () => {
    const base = planTask(newTask(1, 'g', 100, null), { milestones: FIVE, kind: 'coding' } as never, 101).task
    const na = { ...base, gates: { ...base.gates, TEST: { ...base.gates.TEST, state: 'na' as const, isRequired: false, evidence: 'the model said so', source: 'model' as const, at: 102 } } }
    const again = planTask(holdTask(na, 'x', 1, 103), { milestones: FIVE, kind: 'coding' } as never, 104).task
    expect(again.gates.TEST.isRequired).toBe(true)
  })
  test('a held read-only task with an unchanged tree is still checked: the hold, not the tree, asks for it', guard({ stopMaxContinuations: 3 }), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    const h = hostState(on, {})
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    const standing = h.get('task')!
    h.set('task', { value: { ...(standing.value as Task), stopHold: { reason: 'a hold on a task that claimed to be read-only', at: 1, refusals: 0 } }, version: standing.version + 1 })
    expect(taskOf(h).kind).toBe('readonly')
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT).length).toBe(1)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
})
