// H-1 (opus-5-955bfb): in ENFORCE, DONE is backed by a record only the guard writes, for this task and this tree.
// Nothing the model reports (gates, criteria, milestones, TEST, a new read-only plan) can authorize completion.
import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { holdTask, newTask, planTask, settle, setGuardRequired, touchFile } from '../hooks/model'
import type { CheckRecord } from '../hooks/stopguard'
import type { Task } from '../types'
import { FIVE, command, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any, message = SUMMARY) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: message }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const checksOf = (h: ReturnType<typeof hostState>) => (((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? [])
const fixture = (on: any, script: 'fails' | 'ok' = 'fails') => {
  const w = world(on); w.files[SCRIPT] = script === 'fails' ? 'exit 1' : 'exit 0'; w.players[SCRIPT] = script
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}) as never)

  return { w, h: hostState(on, {}) }
}
const finishAll = async ($: any) => { for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m }) }
/** Everything a model can report, up to and including the last milestone; no Stop. */
const modelSaysDone = async ($: any) => {
  await progress($, { action: 'plan', milestones: FIVE })
  for (const m of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone: m })
  await passAllGates($)
  await progress($, { action: 'complete', milestone: 'm5' })
}
const edit = ($: any, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Edit', tool_use_id: `e-${Math.random()}`, file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b', ...extra } as never)
const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
const notDone = (t: Task) => { expect(t.status).not.toBe('done'); expect(t.percent).toBeLessThan(100); expect(t.phase).not.toBe('DONE') }

describe('H-1: the model alone cannot reach DONE in ENFORCE', () => {
  test('reports, criteria, alignment and all milestones, without a Stop: not DONE, no guard record', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    await modelSaysDone($)
    notDone(taskOf(h))
    expect(taskOf(h).guardDone).toBeUndefined()
    expect(checksOf(h).filter(c => c.complete).length).toBe(0)
  })
  test('the next prompt and a read-only plan do not accept the unchecked edit as a baseline', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    w.tree['src/p.ts'] = 'broken'
    await modelSaysDone($)
    await prompt($, 'now just explain it')
    expect(taskOf(h).id).toBe(1)                                                      // the unfinished task goes on
    expect(taskOf(h).stopHold).toBeDefined()                                          // held for the missing completion
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($)
    await stop($)
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notDone(taskOf(h))
  })
  test('SessionStart after an interrupted completion holds the task', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    await modelSaysDone($)
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect(taskOf(h).stopHold).toBeDefined()
    notDone(taskOf(h))
  })
  test('a release is not undone by the next prompt: the finished work is open again until the guard completes it', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    await modelSaysDone($)
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect(taskOf(h).stopHold).toBeDefined()
    await command($, 'guard release')
    await prompt($, 'continue')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeUndefined()                                         // not re-held in a loop
    notDone(taskOf(h))
  })
  test('a person release without a recheck does not allow DONE, even if TEST is reported passed', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    await modelSaysDone($)
    await $.classic.SessionStart({ source: 'resume' } as never)
    await command($, 'guard release')
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran it' })
    await progress($, { action: 'complete', milestone: 'm5' })
    expect(taskOf(h).stopHold).toBeUndefined()
    notDone(taskOf(h))
  })
})

describe('H-1: the guard writes the completion record, for this task and this tree', () => {
  test('legitimate coding completion: check passes, summary given: DONE with a record', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($)
    await modelSaysDone($)
    notDone(taskOf(h))                                                                 // not before the guard has spoken
    expect((await stop($)).block).toBeUndefined()
    const t = taskOf(h)
    expect(t.status).toBe('done'); expect(t.percent).toBe(100)
    expect(t.guardDone?.outcome).toBe('verified')
    expect(typeof t.guardDone?.tree).toBe('string')
    expect(checksOf(h).at(-1)).toMatchObject({ outcome: 'pass', complete: true })
    expect(scriptRuns(w)).toBe(1)
  })
  test('repeated Stop callbacks do not run the script again and stay DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($)
    await stop($); await stop($); await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).status).toBe('done')
  })
  test('a provisional hold is in place while the check runs', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($)
    const seen: { held: boolean; status: string }[] = []
    w.duringRun = async (argv: readonly string[]) => { if (argv[0] === SCRIPT) seen.push({ held: taskOf(h).stopHold !== undefined, status: taskOf(h).status }) }
    await stop($)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(s => s.held && s.status === 'blocked')).toBe(true)              // a host killed here leaves a held task
    expect(taskOf(h).stopHold).toBeUndefined()                                         // released only after the decision was persisted
    expect(taskOf(h).guardDone).toBeDefined()
  })
  test('a tree changed after the successful check is not DONE at the next prompt, and not a baseline', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($); await stop($)
    expect(taskOf(h).status).toBe('done')
    w.tree['src/late-write.ts'] = 'x'                                                  // after the check, by anything
    await prompt($, 'explain it')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).guardDone).toBeUndefined()
    notDone(taskOf(h))
  })
  test('an unchanged tree after the check is still DONE at the next prompt, which starts the next task', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($); await stop($)
    await prompt($, 'explain it')
    expect(taskOf(h).id).toBe(2)
  })
  test('an unknown tree is not a match: the pass leaves no record and the task stays held', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($)
    w.gitHangs = 'diff'
    await stop($)
    const t = taskOf(h)
    expect(t.guardDone).toBeUndefined()
    expect(t.stopHold).toBeDefined()
    notDone(t)
    expect(checksOf(h).some(c => c.complete)).toBe(false)
    expect(checksOf(h).at(-1)?.summary).toMatch(/tree identity|unknown/i)
  })
  test('a record of another task does not authorize this one', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($); await stop($)
    expect(taskOf(h).status).toBe('done')
    await command($, 'reset')
    await prompt($, 'another job'); await edit($)
    await modelSaysDone($)
    notDone(taskOf(h))
    expect(taskOf(h).guardDone).toBeUndefined()
  })
})

describe('H-1: read-only tasks', () => {
  test('a genuinely unchanged read-only task finishes, guard-authorized, with a ledger record', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    notDone(taskOf(h))                                                                 // not before the guard has measured the tree
    await stop($)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
    expect(taskOf(h).guardDone?.outcome).toBe('unchanged')
    expect(checksOf(h).at(-1)).toMatchObject({ outcome: 'unchanged', complete: true })
  })
  test('an interrupted unchanged read-only task is authorized by the next prompt', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await prompt($, 'and the lexer?')
    expect(taskOf(h).id).toBe(2)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('a read-only task whose tree moved, with no Stop, is held at the next prompt', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    w.tree['src/changed.ts'] = 'x'
    await prompt($, 'and the lexer?')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
  })
})

describe('crashes and interruptions', () => {
  test('a turn that ends on an error holds the unchecked completion at once, not at the next prompt', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($)
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't9', reason: 'error' } as never)
    expect(taskOf(h).stopHold).toBeDefined()
    notDone(taskOf(h))
  })

  /** What a host kill leaves between the persisted check and the persisted decision: all work reported, a passing record, the provisional hold, no completion record. */
  const killedAfterCheck = async ($: any, on: any, withRecord = true) => {
    const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)
    let t = planTask(newTask(1, 'fix the parser', 1, null), { milestones: FIVE, kind: 'coding' } as never, 2).task
    t = { ...t, guardSchema: 1, edited: true, milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })), gates: Object.fromEntries(Object.entries(t.gates).map(([k, g]) => [k, { ...g, state: 'pass' as const }])) as Task['gates'] }
    t = holdTask(t, 'a Stop check is in progress', 0, 3)
    const rec: CheckRecord = { taskId: 1, uid: '1@1', verifier: 'v', complete: true, name: 'check.sh', sha: 'abcd1234', at: 4, outcome: 'pass', exit: 0, ms: 5, tree: 'h:0.x', summary: '', hasSummary: true }
    const h = hostState(on, { task: t, 'run-ledger': { ...emptyLedger('s1'), stopChecks: withRecord ? [rec] : [] } })
    await start($)
    return { w, h }
  }
  test('crash after the check, before the decision was persisted: still held, not DONE, across SessionStart and a prompt', guard(), async ($, on) => {
    const { h } = await killedAfterCheck($, on)
    await $.classic.SessionStart({ source: 'resume' } as never)
    await prompt($, 'explain it')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
    notDone(taskOf(h))
  })
  test('and the next Stop checks again and completes it with a fresh record', guard(), async ($, on) => {
    const { w, h } = await killedAfterCheck($, on, false)          // a record of another verifier would (rightly) refuse the script
    await enroll($)
    await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(taskOf(h).guardDone?.outcome).toBe('verified')                              // (the seeded task has no goal check; the guard's part is done)
  })
  test('an edit after DONE withdraws the record and the task is not DONE', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await prompt($, 'fix the parser'); await enroll($)
    await edit($); await modelSaysDone($); await stop($)
    expect(taskOf(h).status).toBe('done')
    await edit($, { tool_use_id: 'later' })
    expect(taskOf(h).guardDone).toBeUndefined()
    notDone(taskOf(h))
  })
})

describe('M-1: an edit the hooks attribute to a helper converts a read-only task', () => {
  test('helper Edit: coding, edited, every gate required, and a later read-only plan cannot undo it', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await edit($, { agentId: 'helper-1' })
    const t = taskOf(h)
    expect(t.kind).toBe('coding'); expect(t.edited).toBe(true)
    for (const g of Object.values(t.gates)) expect(g.isRequired).toBe(true)
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')
    for (const g of Object.values(taskOf(h).gates)) expect(g.isRequired).toBe(true)
  })
})

describe('pure model: the rule', () => {
  const finished = (): Task => {
    let t = planTask(newTask(1, 'g', 1, null), { milestones: [{ title: 'a' }], kind: 'coding' } as never, 2).task
    t = { ...t, milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })), gates: Object.fromEntries(Object.entries(t.gates).map(([k, g]) => [k, { ...g, state: 'pass' as const }])) as Task['gates'] }
    return t
  }
  test('with the guard required, milestones and gates alone are UNVERIFIED; the guard record makes it DONE', () => {
    setGuardRequired(true)
    try {
      const t = settle(finished()).task
      expect(t.status).not.toBe('done')
      const owned = settle({ ...finished(), guardDone: { uid: '1@1', tree: 'h:0.x', check: 'c', outcome: 'verified', at: 3 } }).task
      expect(owned.status).toBe('done')
      const foreign = settle({ ...finished(), guardDone: { uid: '9@9', tree: 'h:0.x', check: 'c', outcome: 'verified', at: 3 } }).task
      expect(foreign.status).not.toBe('done')
    } finally { setGuardRequired(false) }
  })
  test('without the guard, nothing changes', () => {
    setGuardRequired(false)
    expect(settle(finished()).task.status).toBe('done')
  })
  test('an observed edit withdraws the record', () => {
    setGuardRequired(true)
    try {
      const t = touchFile({ ...finished(), guardDone: { uid: '1@1', tree: 'h:0.x', check: 'c', outcome: 'verified', at: 3 } }, 'a.ts', 1, 0)
      expect(t.guardDone).toBeUndefined()
    } finally { setGuardRequired(false) }
  })
  test('a hold wins over a record', () => {
    setGuardRequired(true)
    try {
      expect(settle(holdTask({ ...finished(), guardDone: { uid: '1@1', tree: 'h:0.x', check: 'c', outcome: 'verified', at: 3 } }, 'x', 1, 3)).task.status).toBe('blocked')
    } finally { setGuardRequired(false) }
  })
  void emptyLedger; void planAndComplete; void start
})
