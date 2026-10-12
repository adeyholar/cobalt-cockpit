// Regression coverage for Stop exceptions and failures while persisting a check.
import { describe, expect, test } from 'claude-code/testing'
import { emptyLedger } from '../hooks/ledger'
import { holdTask, newTask, planTask } from '../hooks/model'
import { spentOf } from '../hooks/stopguard'
import type { Task } from '../types'
import { command, FIVE, hostState, start, world } from './world'

const SCRIPT = '/work/check.sh'
const guard = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 2 } }
const base = () => planTask(newTask(1, 'recovery', 100, null), { milestones: FIVE, kind: 'coding' }, 101).task
const stop = ($: any) => $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Changed the parser and added regression coverage for the recovery paths.' })

describe('refusal recovery invariant', () => {
  test('every hold replacement preserves the larger existing or new count', () => {
    const held = holdTask(base(), 'failed', 2, 102)
    expect(holdTask(held, 'exception', 0, 103).stopHold?.refusals).toBe(2)
    expect(holdTask(held, 'older result', 1, 104).stopHold?.refusals).toBe(2)
    expect(holdTask(held, 'next result', 3, 105).stopHold?.refusals).toBe(3)
  })
  test('an unreadable held counter cannot grant a new allowance', () => {
    for (const bad of [undefined, null, -1, 1.5, '2', Number.NaN, Infinity]) {
      const damaged = { ...base(), stopHold: { reason: 'held', at: 102, refusals: bad } } as Task
      expect(spentOf([], damaged)).toBe(10)
      expect(holdTask(damaged, 'exception', 0, 103).stopHold?.refusals).toBe(10)
    }
  })
  test('a Stop exception on an existing exhausted hold preserves its count, then a lost log cannot run again', guard, async ($, on) => {
    const w = world(on)
    w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
    const h = hostState(on, { task: holdTask(base(), 'failed twice', 2, 102), 'run-ledger': emptyLedger('s1') })
    await start($)
    // Malformed host-held ledger raises inside the guard, rather than a test hook being skipped by the host.
    h.set('run-ledger', { value: null, version: 100 })
    await stop($)
    expect((h.get('task')!.value as Task).stopHold?.refusals).toBe(2)
    h.set('run-ledger', { value: emptyLedger('s1'), version: 101 })
    await stop($)
    expect(w.runs.filter(r => r[0] === SCRIPT)).toHaveLength(0)
  })

  for (const failure of ['ledger_write', 'durable_write', 'task_write'] as const) {
    test(`${failure}: failed persistence cannot renew the held budget`, guard, async ($, on) => {
      const w = world(on)
      w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
      let failing = false
      const h = hostState(on, { task: holdTask(base(), 'one attempt spent', 1, 102), 'run-ledger': emptyLedger('s1') }, {
        set: key => failing && key === (failure === 'task_write' ? 'task' : failure === 'ledger_write' ? 'run-ledger' : 'no-state-key'),
      })
      await start($)
      const shown = String((await command($, 'guard trust')).text)
      const hash = /sha-256  ([0-9a-f]{64})/.exec(shown)![1]!
      await command($, `guard trust ${hash.slice(0, 12)}`)
      if (failure === 'durable_write') w.failStoreWrites = ['stop-checks']
      // Ledger fails after the verifier runs, exercising the result-write exception.
      w.duringRun = argv => { if (argv[0] === SCRIPT) failing = failure === 'ledger_write' }
      if (failure === 'task_write') failing = true
      await stop($)
      failing = false
      expect((h.get('task')!.value as Task).stopHold?.refusals).toBe(failure === 'task_write' ? 1 : 2)
      expect(w.runs.filter(r => r[0] === SCRIPT)).toHaveLength(failure === 'task_write' ? 0 : 1)
      if (failure !== 'task_write') {
        h.set('run-ledger', { value: emptyLedger('s1'), version: 100 })
        await stop($)
        expect(w.runs.filter(r => r[0] === SCRIPT)).toHaveLength(1)
      }
    })
  }
})
