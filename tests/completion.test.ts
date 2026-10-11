// Completion integrity (H1-b): a task never reads DONE while an applicable Stop guard check is unresolved, whatever the budget left,
// whatever the task was declared to be, and a person's release does not make verification optional.
import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { summaryOf } from '../hooks/model'
import type { CheckRecord } from '../hooks/stopguard'
import { clearHold, holdTask, newTask, planTask, releaseHold, settle, touchFile } from '../hooks/model'
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
const finishAll = async ($: any) => { for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m }) }
const fixture = (on: any, script = 'fails') => { const w = world(on); w.files[SCRIPT] = script === 'fails' ? 'exit 1' : 'exit 0'; w.players[SCRIPT] = script as never; return { w, h: hostState(on, {}) } }
/** The state every projection reads: none of these may say finished while the task is unresolved. */
const notFinished = (t: Task) => {
  expect(t.status).not.toBe('done')
  expect(t.percent).toBeLessThan(100)
  expect(t.phase).not.toBe('DONE')
}

describe('H1-b: a read-only task whose files change afterwards', () => {
  const readonlyThenChange = async ($: any, w: any) => {
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/changed-later.ts'] = 'x'
  }
  test('the first failed check holds the task at once and it is not DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($)
    const out = await stop($)
    expect(out.block).toBeDefined()
    notFinished(taskOf(h))
    expect(taskOf(h).stopHold).toBeDefined()
    expect(taskOf(h).gates.TEST.isRequired).toBe(true)
  })
  test('the change turns the read-only task into a coding task with required gates', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    const t = taskOf(h)
    expect(t.kind).toBe('coding')
    expect(t.edited).toBe(true)
    for (const g of Object.values(t.gates)) expect(g.isRequired).toBe(true)
  })
  test('declaring read-only again does not undo it', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    await finishAll($)
    expect(taskOf(h).kind).toBe('coding')
    notFinished(taskOf(h))
  })
  test('a person release keeps TEST required and does not restore DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await command($, 'guard release')
    const t = taskOf(h)
    expect(t.stopHold).toBeUndefined()
    expect(t.gates.TEST.isRequired).toBe(true)
    expect(t.gates.TEST.state).toBe('pending')
    notFinished(t)
  })
  test('a progress call cannot report TEST as passed after the first failure', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await readonlyThenChange($, w); await finishAll($); await stop($)
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'I ran it' })
    await passAllGates($)
    notFinished(taskOf(h))
  })
  test('an edit seen by the hooks after the read-only plan converts it too', guard(), async ($, on) => {
    const { h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/example/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).gates.TEST.isRequired).toBe(true)
  })
  test('negative control: an unchanged read-only task stays read-only, light and DONE', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).kind).toBe('readonly')
    expect(taskOf(h).status).toBe('done')
  })
})

describe('every check outcome that does not complete the task holds it', () => {
  test('a first failure on a coding task, budget left: held, and TEST cannot be reported as passed', guard(), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    await progress($, { action: 'gate', gate: 'TEST', state: 'pass', evidence: 'ran it' })
    notFinished(taskOf(h))
  })
  test('a pass without a change summary, budget left: held', guard(), async ($, on) => {
    const { h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($, 'ok')).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('the next stop with a summary and a passing check lifts the hold', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($, 'ok')
    expect(taskOf(h).stopHold).toBeDefined()
    await stop($)
    expect(w.runs.length).toBeGreaterThan(0)
    expect(taskOf(h).stopHold).toBeUndefined()
  })
  test('the budget still ends the loop and the task stays blocked', guard({ stopMaxContinuations: 2 }), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeDefined()
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('an interrupted session: the next prompt does not replace the unresolved task', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/changed-later.ts'] = 'x'
    await finishAll($)
    await stop($)
    const before = taskOf(h)
    await prompt($, 'carry on')
    const after = taskOf(h)
    expect(after.stopHold).toBeDefined()
    expect(after.id).toBe(before.id)
    notFinished(after)
  })
})

describe('pure model: the completion rule and release', () => {
  const done = (): Task => {
    let t = newTask(1, 'g', 1, null)
    t = planTask(t, { milestones: [{ title: 'a' }], kind: 'coding' } as never, 2).task
    return t
  }
  test('releaseHold keeps TEST required, also for a task that was read-only', () => {
    const ro = planTask(newTask(1, 'g', 1, null), { milestones: [{ title: 'a' }], kind: 'readonly' } as never, 2).task
    expect(ro.gates.TEST.isRequired).toBe(false)
    const held = holdTask(ro, 'check failed', 1, 3)
    const out = releaseHold(held, 4)
    expect(out.gates.TEST.isRequired).toBe(true)
    expect(out.gates.TEST.state).toBe('pending')
  })
  test('touchFile on a read-only task converts it', () => {
    const ro = planTask(newTask(1, 'g', 1, null), { milestones: [{ title: 'a' }], kind: 'readonly' } as never, 2).task
    const t = touchFile(ro, 'a.ts', 1, 0)
    expect(t.kind).toBe('coding')
    expect(t.gates.CODE.isRequired).toBe(true)
  })
  test('a hold is never DONE however the milestones stand', () => {
    let t = holdTask(done(), 'x', 1, 3)
    t = { ...t, milestones: t.milestones.map(m => ({ ...m, state: 'done' as const })) }
    const s = settle(t).task
    expect(s.status).toBe('blocked')
    expect(s.percent).toBeLessThan(100)
    expect(settle(clearHold(s, 6)).task.status).not.toBe('blocked')
  })
})

describe('timeout, untrusted and unstable checks hold at once', () => {
  test('a check that cannot run holds the task and is not retried', guard(), async ($, on) => {
    const { h } = fixture(on, 'hangs')
    await start($); await planAndComplete($, 1); await enroll($)
    expect((await stop($)).block).toBeUndefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('an untrusted verifier holds the task and runs nothing', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await planAndComplete($, 1)                                       // never enrolled
    await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
  test('a tree that moves while the check runs holds with budget left', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await start($); await planAndComplete($, 1); await enroll($)
    let n = 0
    w.duringRun = async (argv: readonly string[]) => { if (argv[0] === SCRIPT) w.tree[`src/moving-${n++}.ts`] = 'x' }
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    notFinished(taskOf(h))
  })
})

describe('projections agree on one state', () => {
  test('status, percent, phase, gates, the saved Ledger record and the summary line all say unresolved', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/x.ts'] = 'x'
    await finishAll($); await stop($)
    const t = taskOf(h)
    notFinished(t)
    expect(t.status).toBe('blocked')
    expect(t.gates.TEST.isRequired).toBe(true)
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.outcome).toBe('fail')
    expect(kept.at(-1)?.complete).toBe(false)
    expect(summaryOf(t)).not.toMatch(/\bDONE\b/)
  })
  test('plan and replan cannot restore a read-only exemption on a changed task', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/x.ts'] = 'x'
    await finishAll($); await stop($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await progress($, { action: 'plan', replan: true, kind: 'readonly', milestones: FIVE })
    for (const g of Object.values(taskOf(h).gates)) expect(g.isRequired).toBe(true)
    notFinished(taskOf(h))
  })
})

describe('git index flags and exclude sources', () => {
  const quietRepo = async ($: any, on: any) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    return { w, h }
  }
  test('a file hidden with assume-unchanged is still seen as a change', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'h src/hidden.ts\0'
    w.tree['src/hidden.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/hidden.ts'] = 'two'                                                   // the index says unchanged; the disk does not
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('a file hidden with skip-worktree is still seen as a change', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'S src/skipped.ts\0'
    w.tree['src/skipped.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    w.tree['src/skipped.ts'] = 'two'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('adding to .git/info/exclude is itself a change', guard(), async ($, on) => {
    const { w, h } = await quietRepo($, on)
    w.excludes = 'src/secret-new-file.ts\n'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
  })
  test('negative control: flagged paths that did not change do not force a check', guard(), async ($, on) => {
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, {})
    w.indexFlags = 'h src/hidden.ts\0S src/skipped.ts\0'
    w.tree['src/hidden.ts'] = 'one'; w.tree['src/skipped.ts'] = 'one'
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($); await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
})

describe('Lows: legacy adoption at a prompt, and /clear', () => {
  test('a prompt adopts a legacy held task before it can be replaced', guard(), async ($, on) => {
    world(on)
    on('session.id', () => ({ value: 's1' }))
    const legacyTask = { ...newTask(1, 'g', 1, null), guardSchema: undefined, blocker: 'STOP GUARD: check exit 1 after 3 attempts' } as unknown as Task
    const h = hostState(on, { task: legacyTask, 'run-ledger': { ...emptyLedger('s1'), stopChecks: [{ taskId: 1, uid: '1@1', verifier: 'v', complete: false, name: 'c', sha: 'abcd1234', at: 1, outcome: 'fail', exit: 1, ms: 1, tree: null, summary: 'x', hasSummary: true }] } })
    await start($)
    await prompt($, 'carry on')
    expect(taskOf(h).id).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('/clear records a held task as abandoned, not as passed or done', guard(), async ($, on) => {
    const { h } = fixture(on)
    await start($); await planAndComplete($, 1); await enroll($)
    await stop($)
    expect(taskOf(h).stopHold).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(h.get('task')?.value ?? null).toBeNull()
    const kept = (((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []).at(-1)
    expect(kept?.outcome).toBe('released')
    expect(kept?.name).toBe('clear')
    expect(kept?.summary).toContain('abandoned')
  })
})

// ---------------------------------------------------------------------------
// Change detection is UNCHANGED, CHANGED or UNKNOWN. Unknown is not proof of no change, and it is not proof of one either.
// ---------------------------------------------------------------------------
describe('change detection: UNCHANGED, CHANGED, UNKNOWN', () => {
  const gitRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === 'git').length
  const scriptRuns = (w: any) => w.runs.filter((r: string[]) => r[0] === SCRIPT).length
  const readonlyTask = async ($: any, on: any, setup: (w: any) => void = () => {}, script = 'fails') => {
    const { w, h } = fixture(on, script)
    setup(w)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    return { w, h }
  }
  test('1 small clean repository: UNCHANGED, no check, a handful of git calls', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(12)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('2 large clean repository (50000 index entries, 3000 flagged-clean): UNCHANGED at a constant number of git calls', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.indexFlags = Array.from({ length: 50_000 }, (_, i) => `H src/f${i}.ts`).join('\0') + '\0' })
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(12)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('3 large repository with real modifications: CHANGED, converted, checked, held', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.indexFlags = Array.from({ length: 50_000 }, (_, i) => `H src/f${i}.ts`).join('\0') + '\0' })
    w.tree['src/f7.ts'] = 'edited'
    await finishAll($)
    expect((await stop($)).block).toBeDefined()
    expect(taskOf(h).kind).toBe('coding')
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('4 many untracked files: 5000 are measured in a bounded number of git calls, and still UNCHANGED', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.untracked = Array.from({ length: 5000 }, (_, i) => `gen/u${i}.txt`) })
    expect(taskOf(h).startTree).toEqual(expect.any(String))
    await finishAll($)
    const before = gitRuns(w)
    await stop($)
    expect(gitRuns(w) - before).toBeLessThanOrEqual(30)
    expect(scriptRuns(w)).toBe(0)
    expect(taskOf(h).status).toBe('done')
  })
  test('4b one more untracked file among 5000 is CHANGED', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on, w => { w.untracked = Array.from({ length: 5000 }, (_, i) => `gen/u${i}.txt`) })
    w.untracked.push('gen/new.txt')
    await finishAll($)
    await stop($)
    expect(taskOf(h).kind).toBe('coding')
    expect(scriptRuns(w)).toBeGreaterThan(0)
  })
  test('4c beyond the cap the tree is UNKNOWN: the check runs, the task is not called coding, the reason is recorded', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.untracked = Array.from({ length: 20_001 }, (_, i) => `gen/u${i}.txt`)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')                                              // no known baseline: the claim is not accepted
    await finishAll($)
    const out = await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(out.block).toBeDefined()
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.summary).toContain('change detection unknown')
    expect(kept.at(-1)?.summary).toContain('more than 20000')
    notFinished(taskOf(h))
  })
  test('5 a git timeout is UNKNOWN: checked, bounded, never a manufactured pass', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('readonly')
    await finishAll($)
    w.gitHangs = 'diff'
    const first = await stop($)
    expect(first.block).toBeDefined()
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).kind).toBe('readonly')                                           // unknown is not evidence of a change
    expect(taskOf(h).gates.TEST.state).not.toBe('pass')
    notFinished(taskOf(h))
    await stop($); const last = await stop($)
    expect(last.block).toBeUndefined()                                                // bounded: the loop ends
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('5b a git timeout with a passing check: finished on evidence, not on the absence of it', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    w.gitHangs = 'diff'
    await stop($)
    expect(scriptRuns(w)).toBe(1)
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(taskOf(h).gates.TEST.state).toBe('pass')
  })
  test('7 a non-git workspace: UNKNOWN, checked once on a failing script, held, bounded', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await prompt($, 'explain the parser'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    const out = await stop($)
    expect(out.block).toBeDefined()
    expect(taskOf(h).stopHold).toBeDefined()
    const kept = ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: CheckRecord[] }).stopChecks ?? []
    expect(kept.at(-1)?.summary).toContain('not a git work tree')
    notFinished(taskOf(h))
  })
  test('8 modification before a late read-only declaration is not accepted', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await prompt($, 'explain the parser'); await enroll($)
    w.tree['src/changed-first.ts'] = 'x'
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    expect(taskOf(h).kind).toBe('coding')
    await finishAll($); await stop($)
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
  test('9 modification after a valid read-only declaration is CHANGED at the next stop', guard(), async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    w.tree['src/changed-after.ts'] = 'x'
    await finishAll($); await stop($)
    expect(taskOf(h).kind).toBe('coding')
    notFinished(taskOf(h))
  })
  test('10 unknown fingerprint under ENFORCE never reads VERIFIED DONE without the check', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await prompt($, 'explain'); await enroll($)
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    await finishAll($)
    await stop($)
    expect(scriptRuns(w)).toBeGreaterThan(0)
    notFinished(taskOf(h))
  })
})
