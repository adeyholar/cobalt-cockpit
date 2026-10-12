// v0.5.3 L2/D: the refusal budget of a held task is authoritative on the task itself (`stopHold.refusals`), not only a count
// over a bounded log. Losing, corrupting or flooding the check log cannot give a held task its attempts back.
// Refusal-recovery tests also inject rejected state writes and failed durable writes: reservation precedes the verifier.
// Not claimed: cross-process atomicity. The plugin store has no compare-and-set, so two sessions writing the durable log at the
// same moment can lose a record; the hold's counter lives in the task state, which is why the budget does not depend on it.

import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { holdTask, newTask, planTask } from '../hooks/model'
import { boundedChecks, retainChecks, spentOf } from '../hooks/stopguard'
import type { CheckRecord } from '../hooks/stopguard'
import type { Task } from '../types'
import { FIVE, hostState, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const guard = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 2 } }
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Changed the parser to reject empty input and added a regression test for the empty case.' }) as Promise<{ block?: string }>
const rec = (uid: string, at: number, over: Partial<CheckRecord> = {}): CheckRecord => ({ taskId: 1, uid, verifier: 'v', complete: false, name: 'check.sh', sha: null, at, outcome: 'fail', exit: 1, ms: 5, tree: null, summary: '', hasSummary: false, ...over })
const base = (): Task => planTask(newTask(1, 'goal', 100, null), { milestones: FIVE, kind: 'coding' } as never, 101).task
const heldTask = (refusals: number): Task => holdTask(base(), 'the last check fail: attempt 2 of 2', refusals, 102)
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const flood = (n: number): CheckRecord[] => Array.from({ length: n }, (_, i) => rec(`other${i % 40}`, 1000 + i))

describe('spentOf: the larger of the log and the hold\'s own counter', () => {
  test('log only, hold only, both', () => {
    const t = base()
    const uid = t.lineage ?? `${t.id}@${t.startedAt}`
    expect(spentOf([rec(uid, 1), rec(uid, 2)], t)).toBe(2)
    expect(spentOf([], heldTask(2))).toBe(2)
    expect(spentOf([rec(uid, 1)], heldTask(2))).toBe(2)
    expect(spentOf([rec(uid, 1), rec(uid, 2), rec(uid, 3)], heldTask(1))).toBe(3)
    expect(spentOf([], t)).toBe(0)
  })
  test('a damaged held counter is exhausted rather than granting new attempts', () => {
    for (const bad of [-5, Number.NaN, Infinity, '9', null, 1.5]) expect(spentOf([], { ...heldTask(0), stopHold: { reason: 'r', at: 1, refusals: bad as never } })).toBeLessThanOrEqual(10)
    expect(spentOf([], { ...heldTask(0), stopHold: { reason: 'r', at: 1, refusals: -5 } })).toBe(10)
  })
  test('1000 unrelated checks across many tasks cannot lower a held task\'s budget', () => {
    let list: CheckRecord[] = []
    for (const r of flood(1000)) list = boundedChecks(list, r)
    expect(retainChecks(list).length).toBeLessThanOrEqual(128)
    expect(spentOf(list, heldTask(2))).toBe(2)
  })
})

describe('through the host: the budget survives a lost, corrupted or flooded log', () => {
  const carried = async ($: any, on: any, ledgerChecks: unknown, durable: unknown) => {
    const w = world(on, {}, durable === undefined ? {} : { 'stop-checks': durable })
    w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    on('session.id', () => ({ value: 's1' }))
    on('classic.SessionStart', () => ({}) as never)
    const h = hostState(on, { task: heldTask(2), 'run-ledger': { ...emptyLedger('s1'), ...(ledgerChecks === undefined ? {} : { stopChecks: ledgerChecks }) } })
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)

    return { w, h }
  }
  const ranNothing = (w: ReturnType<typeof world>, h: ReturnType<typeof hostState>) => {
    const records = ((h.get('run-ledger')!.value as { stopChecks?: CheckRecord[] }).stopChecks ?? []).filter(r => r.at >= 5000)
    expect(records).toHaveLength(0)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT)).toHaveLength(0)
    expect(taskOf(h).stopHold).toBeDefined()
  }
  const cases: [string, unknown, unknown][] = [
    ['a missing log (restart, empty ledger, no durable store)', undefined, undefined],
    ['a corrupted durable store', undefined, 'not an object'],
    ['a durable store of the wrong version', undefined, { v: 2, checks: [] }],
    ['a durable log of garbage records', undefined, { v: 1, checks: [1, 'x', null, { uid: 5 }] }],
    ['a ledger and a durable log flooded by 1000 unrelated checks', flood(1000), { v: 1, checks: flood(1000) }],
  ]
  for (const [name, ledger, durable] of cases) {
    test(`${name}: the next stop neither runs the check nor grants attempts`, guard, async ($, on) => {
      const { w, h } = await carried($, on, ledger, durable)
      const out = await stop($)
      expect(out.block).toBeUndefined()
      ranNothing(w, h)
    })
  }
  test('an existing v0.5.2 hold (counter and log as 0.5.2 wrote them) keeps its budget', guard, async ($, on) => {
    const t = base(); const uid = t.lineage ?? `${t.id}@${t.startedAt}`
    const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    on('session.id', () => ({ value: 's1' })); on('classic.SessionStart', () => ({}) as never)
    const h = hostState(on, { task: heldTask(2), 'run-ledger': { ...emptyLedger('s1'), stopChecks: [rec(uid, 10), rec(uid, 11)] } })
    await start($); await $.classic.SessionStart({ source: 'startup' } as never)
    expect((await stop($)).block).toBeUndefined()
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT)).toHaveLength(0)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('a new prompt does not clear the hold or its counter', guard, async ($, on) => {
    const { h } = await carried($, on, undefined, undefined)
    await prompt($, 'what is the state?')
    expect(taskOf(h).stopHold?.refusals).toBe(2)
  })
})
