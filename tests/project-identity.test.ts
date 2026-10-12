// v0.5.3 M2: the project a task began in is part of its fingerprint. Working from another checkout, worktree or
// repository (a changed directory) must never read as "nothing changed": it is UNKNOWN, and UNKNOWN asks for the check.

import { describe, expect, test } from 'claude-code/testing'
import { compareTree } from '../hooks/stopguard'
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

describe('M2: the comparison', () => {
  test('different project identities are UNKNOWN, not CHANGED and not UNCHANGED', () => {
    expect(compareTree('abc:1.ff@1111', 'abc:1.ff@2222')).toBe('UNKNOWN')
  })
  test('same identity compares by content', () => {
    expect(compareTree('abc:1.ff@1111', 'abc:1.ff@1111')).toBe('UNCHANGED')
    expect(compareTree('abc:1.ff@1111', 'abc:2.ee@1111')).toBe('CHANGED')
  })
  test('a fingerprint saved by v0.5.2 (no identity) is UNKNOWN against a v0.5.3 one: it is checked, never trusted', () => {
    expect(compareTree('abc:1.ff', 'abc:1.ff@1111')).toBe('UNKNOWN')
  })
  test('two legacy fingerprints still compare as before', () => {
    expect(compareTree('abc:1.ff', 'abc:1.ff')).toBe('UNCHANGED')
  })
})
