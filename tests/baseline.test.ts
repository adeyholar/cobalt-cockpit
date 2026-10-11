// B1, B2, B3 of the v0.5.2 security review: a Stop check is not skipped because git looks clean at the end, because no task exists,
// or because the change sits inside an ignored directory. Each pair has a guarded case that must check and an unguarded control
// (nothing happened) that must not, so none of them passes by making the fixture permanently dirty or permanently suspicious.
import { describe, expect, test } from 'claude-code/testing'
import type { Task } from '../types'
import { FIVE, CLEAN_REPO, bash, command, hostState, progress, prompt, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any, over: Record<string, unknown> = {}) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY, ...over }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const runs = (w: { runs: string[][] }) => w.runs.filter(r => r[0] === SCRIPT).length
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task | null | undefined
const fixture = (on: any, script: 'fails' | 'ok' = 'fails') => {
  const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = script

  return { w, h: hostState(on, {}) }
}
const keptChecks = (h: ReturnType<typeof hostState>) => ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: { complete: boolean; summary: string; outcome: string }[] }).stopChecks ?? []

describe('B1: a task with no starting fingerprint', () => {
  test('git unreadable at the prompt, clean and committed at the Stop: the check still runs', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.gitStatus = null                                   // not a repository (or a broken one) when the task began
    await start($); await enroll($); await prompt($, 'set up the project')
    w.gitStatus = CLEAN_REPO; w.head = 'c0ffee1'         // the model ran `git init && git commit`: status is clean, HEAD exists
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('the record says the change could not be detected, and a refused check is no completion', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    w.gitStatus = null
    await start($); await enroll($); await prompt($, 'set up the project')
    w.gitStatus = CLEAN_REPO; w.head = 'c0ffee1'
    await stop($)
    expect(keptChecks(h).at(-1)?.summary).toContain('change detection unknown')
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
    expect(taskOf(h)?.guardDone).toBeUndefined()
  })
  test('a repository with no commit at the prompt and one at the Stop: the check still runs', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.head = ''                                          // `git rev-parse --verify HEAD` has nothing to answer
    await start($); await enroll($); await prompt($, 'set up the project')
    w.head = 'c0ffee1'
    await stop($)
    expect(runs(w)).toBe(1)
  })
  test('control: a baseline taken at the prompt, nothing changed since, needs no check', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('control: a baseline taken at the prompt and a change since calls for the check', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'changed'
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
})

describe('B2: work with no task presentation', () => {
  test('after /cockpit reset, a Bash-only change that leaves git clean still calls for the check', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    await command($, 'reset')
    await bash($, 'git init && git add -A && git commit -qm wip')   // the tool hooks cannot see what this wrote
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('a turn driven by a trigger (no person prompt, so no task) that runs Bash is checked', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($)
    await $.prompt.submit({ text: 'scheduled job', wait: false, origin: { kind: 'trigger' } } as never)
    await bash($, 'echo x >> notes.txt && git commit -qam wip')
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('unreadable git and no way to know: a Bash call alone is evidence enough to ask', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.gitStatus = null
    await start($); await enroll($)
    await bash($, 'echo x >> app.py')
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('resetting a task the guard holds does not discharge it: the next task is checked even if nothing else changes', guard({ stopMaxContinuations: 1 }), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'tidy it')
    w.tree['src/a.ts'] = 'changed'
    await stop($)
    const before = runs(w)
    await command($, 'reset')
    await prompt($, 'what is two plus two?')             // a new task whose baseline already contains the unverified change
    await stop($)
    expect(runs(w)).toBeGreaterThan(before)
  })
  test('a completed check discharges the obligation', guard(), async ($, on) => {
    const { w } = fixture(on, 'ok')
    await start($); await enroll($)
    await bash($, 'echo x >> app.py')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(1)
    await stop($)                                        // the guard's own record still matches: nothing to ask again
    expect(runs(w)).toBe(1)
  })
  test('after a completed check the obligation is gone: the next unchanged task is not checked again', guard(), async ($, on) => {
    const { w } = fixture(on, 'ok')
    await start($); await enroll($)
    await bash($, 'echo x >> app.py')
    await stop($)
    expect(runs(w)).toBe(1)
    await command($, 'reset')                            // a verified task is abandoned: nothing is carried
    await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(1)
  })
  test('control: no task and only reads is not asked to verify, even with git unreadable', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.gitStatus = null
    await start($); await enroll($)
    await $.tool.call({ tool: 'Read', file_path: '/work/example/a.ts' } as never)
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('control: reset of a task that did nothing leaves nothing owed', guard(), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    await command($, 'reset')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
})

describe('LOW-1: an incomplete git listing is unknown', () => {
  const WARN = "warning: could not open directory 'secret/': Permission denied"
  for (const [name, listing] of [['untracked', 'untracked'], ['ignored', 'ignored']] as const) {
    test(`a ${name} listing that exits 0 but warns on stderr never reads as unchanged`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      if (listing === 'ignored') w.ignoredEntries = ['dist/a.js']   // the same entries at both measurements: only the warning differs
      await start($); await enroll($); await prompt($, 'explain the parser')
      await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
      for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m })
      w.lsFilesWarning = WARN                   // a writer put files where git cannot list them; git still exits 0
      await stop($)
      expect(taskOf(h)?.guardDone).toBeUndefined()
      expect(taskOf(h)?.status).not.toBe('done')
    })
  }
  test('control: the same task with a silent listing is recorded as unchanged', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await start($); await enroll($); await prompt($, 'explain the parser')
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m })
    expect(w.lsFilesWarning).toBeNull()
    await stop($)
    expect(taskOf(h)?.status).toBe('done')
  })
})

describe('B3: ignored content', () => {
  const ignored = (w: any, files: Record<string, string>) => { w.ignoredFiles = { ...files }; w.dirMeta = { 'cache/': '4096 1000' } }
  test('rewriting an existing file inside an ignored directory (directory stat unchanged) is a change', guard(), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.ignoredFiles['cache/old.txt'] = '3 2000'            // same size, later mtime; the parent directory did not move
    expect((await stop($)).block).toBeDefined()
    expect(runs(w)).toBe(1)
  })
  test('a new file under an existing ignored directory is a change', guard(), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.ignoredFiles['cache/new.txt'] = '9 2000'
    expect((await stop($)).block).toBeDefined()
  })
  test('a rewrite in a nested ignored directory is a change', guard(), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/a/b/deep.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'tidy it')
    w.ignoredFiles['cache/a/b/deep.txt'] = '3 3000'
    expect((await stop($)).block).toBeDefined()
  })
  test('a read-only task that rewrote an ignored file is not recorded as unchanged and does not finish', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'explain the parser')
    await progress($, { action: 'plan', kind: 'readonly', milestones: FIVE })
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await progress($, { action: 'complete', milestone: m })
    w.ignoredFiles['cache/old.txt'] = '3 2000'
    await stop($)
    expect(runs(w)).toBe(1)
    expect(taskOf(h)?.guardDone).toBeUndefined()
    expect(taskOf(h)?.status).not.toBe('done')
  })
  test('control: ignored files nobody touched leave the fingerprint equal and need no check', guard(), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000', 'cache/a/b/deep.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('an operator-listed volatile directory is left out, and only that one', guard({ stopVolatile: 'cache/' }), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000', 'node_modules/x/i.js': '3 1000' })
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    w.ignoredFiles['cache/old.txt'] = '3 2000'
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
    w.ignoredFiles['node_modules/x/i.js'] = '3 2000'
    expect((await stop($)).block).toBeDefined()
  })
  test('a directory the operator watches: a modified child is a change', guard({ stopWatch: '/work/conf' }), async ($, on) => {
    const { w } = fixture(on)
    w.watchedDirs['/work/conf'] = ['/work/conf/a.cfg', '/work/conf/b.cfg']
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    w.ignoredMeta['/work/conf/b.cfg'] = '5 9999'
    expect((await stop($)).block).toBeDefined()
  })
  test('a watched directory whose files cannot be measured is UNKNOWN, never a match', guard({ stopWatch: '/work/conf' }), async ($, on) => {
    const { w, h } = fixture(on)
    w.watchedDirs['/work/conf'] = Array.from({ length: 100_001 }, (_, i) => `/work/conf/f${i}`)
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    await stop($)
    expect(runs(w)).toBe(1)
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
  })
  test('measuring the ignored files past the time budget is UNKNOWN, never a partial match', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    w.ignoredFiles = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`out/f${i}`, '1 1']))
    await start($); await enroll($); await prompt($, 'tidy it')
    w.duringRun = async argv => { if (argv[0] === 'stat') await w.clock.advance(30_000) }
    await stop($)
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
    expect(keptChecks(h).at(-1)?.summary).toContain('longer than 25s')
  })
  test('an ignored directory holding its own repository (listed by git as one entry) is expanded: a same-size rewrite and a deeper new file are changes', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.embeddedRepos = { 'vendor/dep/': ['/work/example/vendor/dep/x.py', '/work/example/vendor/dep/sub/y.py'] }
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
    w.ignoredMeta['/work/example/vendor/dep/sub/y.py'] = '5 7777'      // rewritten inside; the repository directory's own stat did not move
    expect((await stop($)).block).toBeDefined()
  })
  test('an embedded repository that cannot be listed in full makes the tree UNKNOWN, never a partial match', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    w.embeddedRepos = { 'vendor/dep/': ['/work/example/vendor/dep/x.py'] }
    w.watchedUnreadable = ['/work/example/vendor/dep']
    await start($); await enroll($); await prompt($, 'tidy it')
    await stop($)
    expect(runs(w)).toBe(1)
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
    expect(taskOf(h)?.guardDone).toBeUndefined()
  })
  test('a watched directory with an unreadable subdirectory is UNKNOWN, not a constant "missing"', guard({ stopWatch: '/work/conf' }), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    w.watchedDirs['/work/conf'] = ['/work/conf/a.cfg']
    w.watchedUnreadable = ['/work/conf']
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    await stop($)
    expect(runs(w)).toBe(1)
    expect(keptChecks(h).at(-1)?.summary).toContain('could not be listed in full')
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
  })
  test('LOW-2: a watched path under a parent that cannot be entered is UNKNOWN, not a constant "missing"', guard({ stopWatch: '/work/closed/conf' }), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    w.watchedDenied = ['/work/closed/conf']
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    await stop($)
    expect(runs(w)).toBe(1)
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
    expect(taskOf(h)?.guardDone).toBeUndefined()
  })
  test('control: a watched path that does not exist is a stable "missing", not UNKNOWN', guard({ stopWatch: '/work/absent' }), async ($, on) => {
    const { w } = fixture(on)
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    expect((await stop($)).block).toBeUndefined()
    expect(runs(w)).toBe(0)
  })
  test('more ignored files than the bound is UNKNOWN: the check runs and no completion is recorded', guard(), async ($, on) => {
    const { w, h } = fixture(on, 'ok')
    w.ignoredFiles = Object.fromEntries(Array.from({ length: 100_001 }, (_, i) => [`out/f${i}`, '1 1']))
    await start($); await enroll($); await prompt($, 'tidy it')
    await stop($)
    expect(runs(w)).toBe(1)
    expect(keptChecks(h).at(-1)?.complete).toBe(false)
    expect(taskOf(h)?.guardDone).toBeUndefined()
  })
  test('the listing names every file (not --directory) and prunes only operator-listed prefixes', guard({ stopVolatile: 'cache/' }), async ($, on) => {
    const { w } = fixture(on)
    ignored(w, { 'cache/old.txt': '3 1000' })
    await start($); await enroll($); await prompt($, 'what is two plus two?')
    const listing = w.runs.filter(r => r[0] === 'git' && r.includes('-i'))
    expect(listing.length).toBeGreaterThan(0)
    for (const argv of listing) {
      expect(argv).not.toContain('--directory')
      expect(argv).toContain(':(exclude)cache/')
    }
  })
})
