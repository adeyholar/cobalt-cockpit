// v0.5.3 M2: the project a task began in is part of its fingerprint. Working from another checkout, worktree or
// repository (a changed directory) must never read as "nothing changed": it is UNKNOWN, and UNKNOWN asks for the check.

import { describe, expect, test } from 'claude-code/testing'
import { STAMP_MAX, compareTree, validChecks } from '../hooks/stopguard'
import type { Task } from '../types'
import { FIVE, command, hostState, progress, prompt, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 1 } }
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const finishAll = async ($: any) => { for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m }) }
const readonlyTask = async ($: any, on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
  const h = hostState(on, {})
  await prompt($, 'explain the parser'); await enroll($)
  await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })

  return { w, h }
}

describe('M2: a changed project is never UNCHANGED', () => {
  test('control: the same checkout stays unchanged and runs no check', guard, async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    await finishAll($); await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT)).toHaveLength(0)
    expect(taskOf(h).guardDone?.outcome).toBe('unchanged')
  })
  test('another checkout with the same commit is UNKNOWN: the check runs, no unchanged record is made', guard, async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    await finishAll($)
    w.top = '/work/clean-clone'                 // the session moved to a pristine checkout of the same commit
    await stop($)
    expect(w.runs.filter((r: string[]) => r[0] === SCRIPT).length).toBeGreaterThan(0)
    expect(taskOf(h).guardDone?.outcome).not.toBe('unchanged')
    expect(taskOf(h).status).not.toBe('done')
  })
  test('moving away and back is the same project again', guard, async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    await finishAll($)
    w.top = '/work/elsewhere'; w.top = '/work/example'
    await stop($)
    expect(taskOf(h).guardDone?.outcome).toBe('unchanged')
  })
})

const ID_A = 'a'.repeat(32)
const ID_B = 'b'.repeat(32)

describe('M2: the comparison', () => {
  test('different project identities are UNKNOWN, not CHANGED and not UNCHANGED', () => {
    expect(compareTree(`abc:1.ff@${ID_A}`, `abc:1.ff@${ID_B}`)).toBe('UNKNOWN')
  })
  test('same identity compares by content', () => {
    expect(compareTree(`abc:1.ff@${ID_A}`, `abc:1.ff@${ID_A}`)).toBe('UNCHANGED')
    expect(compareTree(`abc:1.ff@${ID_A}`, `abc:2.ee@${ID_A}`)).toBe('CHANGED')
  })
  test('a fingerprint saved by v0.5.2 (no identity) is UNKNOWN against a current one, and against another legacy one', () => {
    expect(compareTree('abc:1.ff', `abc:1.ff@${ID_A}`)).toBe('UNKNOWN')
    expect(compareTree('abc:1.ff', 'abc:1.ff')).toBe('UNKNOWN')
  })
  test('a fingerprint of the earlier 32-bit v0.5.3 build is UNKNOWN, equal or not', () => {
    expect(compareTree('abc:1.ff@1a2b3c4d', `abc:1.ff@${ID_A}`)).toBe('UNKNOWN')
    expect(compareTree('abc:1.ff@1a2b3c4d', 'abc:1.ff@1a2b3c4d')).toBe('UNKNOWN')
  })
  test('malformed, truncated and oversized fingerprints are UNKNOWN', () => {
    for (const bad of [`abc:1.ff@${'a'.repeat(31)}`, `abc:1.ff@${'A'.repeat(32)}`, `abc:1.ff@${'g'.repeat(32)}`, `abc:1.ff@${ID_A}x`, 'abc:1.ff@', '@', '', `abc:1.ff@${'a'.repeat(40)}`, 'x'.repeat(400) + `@${ID_A}`]) {
      expect(compareTree(bad, `abc:1.ff@${ID_A}`)).toBe('UNKNOWN')
      expect(compareTree(bad, bad)).toBe('UNKNOWN')
    }
    expect(compareTree(null, `abc:1.ff@${ID_A}`)).toBe('UNKNOWN')
    expect(compareTree(`abc:1.ff@${ID_A}`, null)).toBe('UNKNOWN')
  })
})

describe('M2: the fingerprint through the host', () => {
  test('it carries a 128-bit hash of the project and no path', guard, async ($, on) => {
    const { h } = await readonlyTask($, on)
    const tree = taskOf(h).startTree as string
    expect(tree).toMatch(/@[0-9a-f]{32}$/)
    expect(tree).not.toContain('work')
    expect(tree).not.toContain('example')
  })
  test('two projects with the same commit and content get different identities', guard, async ($, on) => {
    const { w, h } = await readonlyTask($, on)
    const a = taskOf(h).startTree as string
    await command($, 'reset')
    w.top = '/work/example2'
    w.cwd = w.top // a real second project changes both the host directory and Git's reported root
    await prompt($, 'explain another thing')
    const b = taskOf(h).startTree as string
    expect(a.slice(0, a.indexOf('@'))).toBe(b.slice(0, b.indexOf('@')))
    expect(a).not.toBe(b)
  })
})

describe('M2/E: the fingerprint survives its own storage at every supported size', () => {
  const rec = (tree: string | null) => ({ taskId: 1, uid: 'u', verifier: 'v', complete: false, name: 'c.sh', sha: null, at: 1, outcome: 'fail', exit: 1, ms: 1, tree, summary: '', hasSummary: false })
  // the longest stamp this build can write: a SHA-256 repository (64 hex head), a nine-digit entry count, two 32-bit hashes, the 128-bit project
  const longest = `${'f'.repeat(64)}:${'9'.repeat(9)}.${'f'.repeat(16)}@${'f'.repeat(32)}`
  test('the longest stamp is stored, an oversized one is dropped', () => {
    expect(longest.length).toBeLessThanOrEqual(STAMP_MAX)
    expect(validChecks([rec(longest)])).toHaveLength(1)
    expect(validChecks([rec(`${longest}${'f'.repeat(STAMP_MAX)}`)])).toHaveLength(0)
    expect(validChecks([rec(null)])).toHaveLength(1)
  })
  test('a SHA-1 stamp at the supported file-count limits is stored', () => {
    for (const n of [0, 20_000, 100_000, 140_001]) expect(validChecks([rec(`${'a'.repeat(40)}:${n}.${'f'.repeat(16)}@${ID_A}`)])).toHaveLength(1)
  })
})
