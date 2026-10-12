// v0.5.3 L2: the guard's check records are kept per task. Records of unrelated tasks cannot push a held task's attempts
// out of the bounded store (which would hand it a fresh refusal budget).

import { describe, expect, test } from 'claude-code/testing'
import { attemptsOf, boundedChecks, validChecks } from '../hooks/stopguard'
import type { CheckRecord } from '../hooks/stopguard'

const rec = (uid: string, at: number, over: Partial<CheckRecord> = {}): CheckRecord => ({ taskId: 1, uid, verifier: 'v', complete: false, name: 'check.sh', sha: null, at, outcome: 'fail', exit: 1, ms: 5, tree: null, summary: '', hasSummary: false, ...over })
const fill = (n: number, uid: (i: number) => string, from = 100): CheckRecord[] => Array.from({ length: n }, (_, i) => rec(uid(i), from + i))

describe('L2: check records are bounded per task, not in one shared pool', () => {
  test('control: the pool is still bounded', () => {
    let list: CheckRecord[] = []
    for (const r of fill(500, i => `u${i}`)) list = boundedChecks(list, r)
    expect(list.length).toBeLessThanOrEqual(128)
  })
  test('a flood from unrelated tasks does not evict a held task\'s attempts', () => {
    let list: CheckRecord[] = []
    for (const r of [rec('held', 1), rec('held', 2), rec('held', 3)]) list = boundedChecks(list, r)
    expect(attemptsOf(list, 'held')).toBe(3)
    for (const r of fill(60, i => `other${i % 6}`)) list = boundedChecks(list, r)
    expect(attemptsOf(list, 'held')).toBe(3)
  })
  test('one task cannot grow without bound either', () => {
    let list: CheckRecord[] = []
    for (const r of fill(100, () => 'chatty')) list = boundedChecks(list, r)
    expect(list.filter(c => c.uid === 'chatty').length).toBeLessThanOrEqual(16)
  })
  test('a loaded store keeps the same rule', () => {
    const stored = [...fill(3, () => 'held', 1), ...fill(60, i => `other${i % 6}`)]
    expect(attemptsOf(validChecks(stored), 'held')).toBe(3)
  })
})
