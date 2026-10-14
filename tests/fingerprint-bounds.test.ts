// v0.6.4 fingerprint resource hardening. A repository decided what the v0.6.3 fingerprint read: an untracked link to /dev/zero,
// an excludes or attributes file pointed at a device, a FIFO where Git expects a file. Measured with real Git under hard limits,
// each exhausted memory within a second or blocked until the host's timeout. Here, through the host: every measurement process
// starts under the limit script, nothing that is not an ordinary file is ever read, every limit ends in UNKNOWN with its reason,
// and an UNKNOWN never reads as a clean tree, a passing check or DONE. Each hazard has a control that still measures normally.
import { describe, expect, test } from 'claude-code/testing'
import { BOUND_PROBE_CAPPED, BOUND_PROBE_CONTROL, BOUND_PROBE_SET, FINGERPRINT_FILE_BYTES, GIT_BOUNDED, SOURCE_BYTES, boundScript, inspectedOf, kindOfMode } from '../hooks/git-integrity'
import type { Task } from '../types'
import { CLEAN_REPO, bash, blobOf, command, FIVE, GATE_NAMES, hostState, passAllGates, planAndComplete, progress, prompt, start, world } from './world'
import type { World } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = (extra: Record<string, unknown> = {}) => ({ options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 3, ...extra } })
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const enroll = async ($: any): Promise<void> => {
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
}
const checks = (w: World) => w.runs.filter(r => r[0] === SCRIPT).length
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')?.value as Task | null | undefined
const kept = (h: ReturnType<typeof hostState>) => ((h.get('run-ledger')?.value ?? {}) as { stopChecks?: { complete: boolean; summary: string }[] }).stopChecks ?? []
/** A passing check script: a check that completes shows the tree was measured; one that cannot complete shows it was not. */
const fixture = (on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 0'; w.players[SCRIPT] = 'ok'

  return { w, h: hostState(on, {}) }
}
/** A task begun on a measured tree, ready for its Stop. */
const begun = async ($: any) => { await start($); await enroll($); await prompt($, 'tidy it') }
const MEASURING = ['git', 'stat', 'find', 'readlink', 'realpath']
/** Every path given to a reading `hash-object` (not --stdin, which reads a link's text from the plugin), as the plugin named it. */
const hashedPaths = (w: World) => w.runs.filter(r => r[0] === 'git' && r.includes('hash-object') && !r.includes('--stdin')).flatMap(r => r.slice(r.indexOf('--') + 1).map(p => p.replace(/^\.\//, '')))
const gitSubcommands = (w: World, from = 0) => w.runs.slice(from).filter(r => r[0] === 'git').map(r => { let at = 1; while (r[at] === '-c' || r[at] === '-C' || r[at]?.startsWith('--no-') || r[at] === '--literal-pathspecs') at += r[at] === '-c' || r[at] === '-C' ? 2 : 1; return r[at] })
/**
 * The Stop's own measurement was not believed: it is recorded as UNKNOWN with its reason. (A later measurement of a tree that
 * has settled is a new measurement, and may identify it; a one-time swap is not a lasting UNKNOWN.)
 */
const notBelieved = (h: ReturnType<typeof hostState>, why: string) => expect(kept(h).at(-1)?.summary).toContain(`[change detection unknown: ${why}`)
/** The Stop could not identify the tree: the passing check is not recorded as verified, and the reason is kept. */
const unidentified = (h: ReturnType<typeof hostState>, why: string) => {
  const last = kept(h).at(-1)
  expect(last?.complete).toBe(false)
  expect(last?.summary).toContain(why)
  expect(taskOf(h)?.guardDone).toBeUndefined()
  expect(taskOf(h)?.status).not.toBe('done')
}

describe('the limit script', () => {
  test('is one constant: memory, CPU, file size and no core, each only ever lowered, then exec of the words it is given', () => {
    const lower = 'lower() { c=$(ulimit "$1") || return 1; if [ "$c" = unlimited ] || [ "$c" -gt "$2" ]; then ulimit "$1" "$2"; fi; }'
    expect(boundScript(true)).toBe(`${lower} && lower -v 1048576 && lower -t 20 && lower -f 131072 && lower -c 0 && exec "$@"`)
    expect(boundScript(false)).toBe(`${lower} && lower -t 20 && lower -f 131072 && lower -c 0 && exec "$@"`)
    // no command word is ever interpolated: the probes and the script are fixed strings
    for (const s of [boundScript(true), boundScript(false), BOUND_PROBE_SET(true), BOUND_PROBE_CONTROL, BOUND_PROBE_CAPPED]) expect(s).not.toMatch(/\$\{|`/)
    expect(GIT_BOUNDED).toContain('core.hooksPath=/dev/null')
    expect(GIT_BOUNDED).toContain('diff.orderFile=/dev/null')
  })
  test('inspection records are parsed strictly, in either stat form, and a kind comes from the mode alone', () => {
    expect(inspectedOf('81a4 12 7 1.5 1.5 ./a b', true)).toEqual({ kind: 'file', mode: 0x81a4, size: 12, identity: '81a4 12 7 1.5 1.5', name: './a b' })
    expect(inspectedOf('100644 12 7 1 1', false)?.kind).toBe('file')
    expect(inspectedOf('20666 0 7 1 1', false)?.kind).toBe('char')
    for (const bad of ['', '81a4 12 7 1.5 1.5', '81a4 12 7 1.5', '81a4 -1 7 1 1 a', 'zz 1 1 1 1 a', `81a4 ${'9'.repeat(30)} 1 1 1 a`]) expect(inspectedOf(bad, true)).toBeNull()
    for (const bad of ['100644 12 7 1 1 extra', '100644 12 7 1.5 1']) expect(inspectedOf(bad, false)).toBeNull()
    expect([0o100644, 0o120777, 0o040755, 0o010644, 0o140755, 0o020666, 0o060660].map(kindOfMode)).toEqual(['file', 'link', 'dir', 'fifo', 'socket', 'char', 'block'])
    expect(kindOfMode(0)).toBeNull()
  })
})

describe('every measurement process is bounded', () => {
  const busyTree = (w: World) => {
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    w.untracked = ['notes.md', 'latest']; w.kinds['latest'] = 'link'
    w.ignoredEntries = ['.cache/x']
  }
  test('full: git, stat, find, readlink and realpath all start under the script, Git with the bounded settings', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w)
    await begun($); w.tree['src/a.ts'] = 'b'; await stop($)
    const measuring = w.runs.map((r, i) => ({ r, script: w.wrappers[i], env: w.runEnvs[i] })).filter(x => MEASURING.includes(x.r[0]!))
    expect(measuring.length).toBeGreaterThan(20)
    for (const x of measuring) {
      expect(x.script).toBe(boundScript(true))
      expect(x.env?.['MALLOC_ARENA_MAX']).toBe('2')
      if (x.r[0] === 'git') expect(x.r.slice(1, 1 + GIT_BOUNDED.length)).toEqual(GIT_BOUNDED)
    }
    expect(measuring.some(x => x.r[0] === 'readlink')).toBe(true)
    // the limits are probed once for the registration, not once per process
    expect(w.boundProbes).toEqual([BOUND_PROBE_SET(true), BOUND_PROBE_CONTROL, BOUND_PROBE_CAPPED])
  })
  test('full: only reading Git subcommands run, hash-object never writes an object, and nothing destructive is started', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w)
    await begun($); w.tree['src/a.ts'] = 'b'; await stop($)
    const reading = new Set(['rev-parse', 'config', 'ls-tree', 'ls-files', 'check-attr', 'diff', 'hash-object', 'status'])
    expect(gitSubcommands(w).filter(s => !reading.has(s!))).toEqual([])
    expect(w.runs.some(r => r[0] === 'git' && r.includes('hash-object') && r.includes('-w'))).toBe(false)
    expect(w.runs.filter(r => r[0] === 'git' && r.includes('config')).every(r => r.some(a => a === '--get' || a === '--get-regexp'))).toBe(true)
    expect(w.runs.filter(r => !MEASURING.includes(r[0]!) && r[0] !== SCRIPT)).toEqual([])
  })
  test('partial: where the memory cap is accepted but not enforced, CPU and file limits still apply and doctor says so', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.boundMode = 'partial'
    await begun($); await stop($)
    const scripts = new Set(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)))
    expect([...scripts]).toEqual([boundScript(false)])
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('WARN working-tree measurement runs under CPU 20 s, files written at most 64 MiB and the host\'s timeout; this platform does NOT enforce the memory limit')
  })
  test('none: with no shell to set limits the commands run directly, and doctor warns', guard(), async ($, on) => {
    const { w } = fixture(on); busyTree(w); w.boundMode = 'none'
    await begun($); await stop($)
    expect(w.wrappers.filter((_, i) => MEASURING.includes(w.runs[i]![0]!)).every(s => s === null)).toBe(true)
    expect(String((await command($, 'doctor')).text)).toContain('WARN working-tree measurement runs under the host\'s timeout only')
  })
  test('full: doctor reports the enforced limits', async ($, on) => {
    world(on); await start($)
    expect(String((await command($, 'doctor')).text)).toContain('OK   working-tree measurement runs under kernel limits: memory 1024 MiB, CPU 20 s, files written at most 64 MiB, no core dump')
  })
})

describe('vector 1: an untracked symbolic link to an unbounded device', () => {
  const link = (w: World, name: string, target: string) => { if (!w.untracked.includes(name)) w.untracked.push(name); w.kinds[name] = 'link'; w.linkTargets[name] = target }
  test('a new link to /dev/zero is a change measured by its text: Git never reads what it leads to', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); link(w, 'link-zero', '/dev/zero')
    await stop($)
    expect(checks(w)).toBe(1)                                                      // a change, so the check ran
    expect(kept(h).at(-1)?.complete).toBe(true)                                    // and the tree was identified
    expect(hashedPaths(w)).not.toContain('link-zero')
    expect(w.runs.some(r => r[0] === 'readlink' && r.at(-1) === './link-zero')).toBe(true)
  })
  test('control: the same link, there at the prompt and unchanged, is no change', guard(), async ($, on) => {
    const { w } = fixture(on); link(w, 'link-zero', '/dev/zero'); link(w, 'link-fifo', '/tmp/fifo')
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
    expect(hashedPaths(w).filter(p => p.startsWith('link-'))).toEqual([])
  })
  test('pointing an existing link somewhere else is a change', guard(), async ($, on) => {
    const { w } = fixture(on); link(w, 'current', 'v1.md')
    await begun($); link(w, 'current', '/dev/zero')
    await stop($)
    expect(checks(w)).toBe(1)
  })
  test('a FIFO, socket or device among the flagged paths is measured by its kind alone and never opened', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.indexFlags = 'S pipe\0S sock\0S zero\0'; w.kinds = { pipe: 'fifo', sock: 'socket', zero: 'char' }
    await begun($)
    expect((await stop($)).block).toBeUndefined()                                // measured, and equal to the prompt's measurement
    expect(hashedPaths(w).filter(p => ['pipe', 'sock', 'zero'].includes(p))).toEqual([])
  })
  test('a flagged path that turns from a file into a FIFO is a change', guard(), async ($, on) => {
    const { w } = fixture(on); w.indexFlags = 'S pipe\0'
    await begun($)
    expect(hashedPaths(w)).toContain('pipe')                                        // read as a file at the prompt
    w.kinds.pipe = 'fifo'
    const from = w.runs.length
    await stop($)
    expect(checks(w)).toBe(1)
    expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain('pipe')  // never opened as a FIFO
  })
})

describe('vector 2: configuration redirecting an input to an unbounded device', () => {
  const cases: { name: string; set: (w: World) => void; why: string; read: string }[] = [
    { name: 'core.excludesFile = /dev/zero', set: w => { w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }, why: 'core.excludesFile is a character device, not an ordinary file', read: '/dev/zero' },
    { name: 'core.attributesFile = /dev/zero', set: w => { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }, why: 'core.attributesFile is a character device', read: '/dev/zero' },
    { name: 'core.attributesFile = a FIFO', set: w => { w.gitConfig['core.attributesFile'] = '/tmp/attr-fifo'; w.kinds['/tmp/attr-fifo'] = 'fifo' }, why: 'core.attributesFile is a FIFO', read: '/tmp/attr-fifo' },
    { name: '.git/info/attributes linked to /dev/zero', set: w => { w.kinds['.git/info/attributes'] = 'link'; w.followKinds['.git/info/attributes'] = 'char' }, why: 'info/attributes is a character device', read: '/work/example/.git/info/attributes' },
    { name: '.git/info/exclude linked to a block device', set: w => { w.kinds['.git/info/exclude'] = 'link'; w.followKinds['.git/info/exclude'] = 'block' }, why: 'info/exclude is a block device', read: '/work/example/.git/info/exclude' },
    { name: 'objects/info/alternates linked to /dev/zero', set: w => { w.kinds['.git/objects/info/alternates'] = 'link'; w.followKinds['.git/objects/info/alternates'] = 'char' }, why: 'objects/info/alternates is a character device', read: '/work/example/.git/objects/info/alternates' },
    { name: 'a 200 MB core.excludesFile', set: w => { w.gitConfig['core.excludesFile'] = '/home/tester/huge-ignore'; w.sizes['/home/tester/huge-ignore'] = 200_000_000 }, why: `core.excludesFile is larger than ${SOURCE_BYTES / 1024 / 1024} MiB`, read: '/home/tester/huge-ignore' },
  ]
  for (const c of cases) {
    test(`${c.name}: UNKNOWN with the reason, refused before any Git command that would read it`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      await begun($)
      c.set(w)
      const from = w.runs.length
      await stop($)
      unidentified(h, c.why)
      expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain(c.read)
      // the listing, diffing, attribute and status commands that would read it never started
      expect(gitSubcommands(w, from).filter(s => ['ls-files', 'diff', 'check-attr', 'status', 'ls-tree', 'hash-object'].includes(s!))).toEqual([])
    })
  }
  test('diff.orderFile = /dev/zero: every Git command the plugin starts overrides it, so nothing reads it', guard(), async ($, on) => {
    const { w } = fixture(on)
    await begun($); w.gitConfig['diff.orderFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char'; w.watched['x'] = ''
    await stop($)
    const gits = w.runs.filter(r => r[0] === 'git')
    expect(gits.length).toBeGreaterThan(10)
    for (const r of gits) expect(r[r.indexOf('diff.orderFile=/dev/null') - 1]).toBe('-c')
    for (const r of gits.filter(r => r.includes('diff'))) expect(r).toContain('-O/dev/null')
  })
  test('a configuration Git cannot read in time is UNKNOWN, never a missing setting', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitHangs = 'config'
    await stop($)
    unidentified(h, 'git raised an error or timed out')
  })
  test('control: ordinary excludes and attributes files, kept as links to regular files, still measure, and editing one is a change', guard(), async ($, on) => {
    const { w } = fixture(on)
    w.gitConfig['core.excludesFile'] = '/home/tester/.gitignore_global'; w.kinds['/home/tester/.gitignore_global'] = 'link'; w.excludes = 'dist/\n'
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
    w.excludes = 'dist/\nsecret.txt\n'
    await prompt($, 'again'); w.excludes = 'dist/\nsecret.txt\ncache/\n'
    await stop($)
    expect(checks(w)).toBe(1)
  })
  for (const device of [false, true]) {
    test(`the release check ${device ? 'refuses a candidate while an attributes file is a device' : 'admits the same clean candidate (control)'}`, { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
      const w = world(on); hostState(on, {})
      w.headBlobs.a = blobOf('original'); w.watched.a = 'original'; w.indexFlags = 'H a\0'
      w.gitFilterConfig = 'filter.lfs.process\ngit-lfs filter-process\0'; w.gitFilterAttributes = 'a\0filter\0unspecified\0'
      if (device) { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
      const answer = await admit($)
      if (!device) { expect(answer).toContain('OPUS ADMITTED'); expect(gitSubcommands(w)).toContain('check-attr'); return }
      expect(answer).not.toContain('OPUS ADMITTED')
      expect(gitSubcommands(w).filter(s => s === 'check-attr')).toEqual([])
    })
  }
})

describe('vector 3: FIFOs and other non-regular Git metadata', () => {
  // Real Git blocks on a FIFO .gitignore, .gitattributes, HEAD, index or config until it is killed (reproduced); the host's
  // timeout kills it. Here the timeout is what the plugin sees, and it must read as UNKNOWN.
  for (const [what, sub] of [['a FIFO .gitignore', 'ls-files'], ['a FIFO HEAD', 'rev-parse'], ['a FIFO .gitattributes', 'check-attr'], ['a FIFO index', 'diff']] as const) {
    test(`${what} blocks git ${sub} until the host's timeout: UNKNOWN, never clean`, guard(), async ($, on) => {
      const { w, h } = fixture(on)
      await begun($); w.gitHangs = sub
      // attributes are checked for a configured filter driver (an installed LFS, say)
      if (sub === 'check-attr') { w.gitFilterConfig = 'filter.lfs.process\ngit-lfs filter-process\0'; w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a' }
      await stop($)
      unidentified(h, 'git raised an error or timed out')
    })
  }
  test('a configured excludes file that is a FIFO is refused before Git opens it', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitConfig['core.excludesFile'] = '/tmp/pipe'; w.kinds['/tmp/pipe'] = 'fifo'
    await stop($)
    unidentified(h, 'core.excludesFile is a FIFO, not an ordinary file')
  })
  for (const kind of ['fifo', 'socket', 'char', 'block', 'dir'] as const) {
    test(`a tracked file replaced by a ${kind} is never read: UNKNOWN`, guard(), async ($, on) => {
      const { w, h } = fixture(on); w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
      await begun($); w.kinds['src/a.ts'] = kind
      const from = w.runs.length
      await stop($)
      unidentified(h, 'a tracked path is not an ordinary file or symbolic link')
      expect(hashedPaths({ ...w, runs: w.runs.slice(from) })).not.toContain('src/a.ts')
    })
  }
  test('a watched path that is a FIFO is never read: UNKNOWN', guard({ stopWatch: 'config/pipe' }), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.kinds['config/pipe'] = 'fifo'
    await stop($)
    unidentified(h, 'the watched path config/pipe is a FIFO, which is never read')
  })
})

describe('limits: sizes, totals, output and time', () => {
  test('an untracked file over 1 GiB is not read: UNKNOWN with the reason', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['big.bin']; w.sizes['big.bin'] = FINGERPRINT_FILE_BYTES + 1
    await stop($)
    unidentified(h, 'a file is larger than 1 GiB')
    expect(hashedPaths(w)).not.toContain('big.bin')
  })
  test('a tracked file over 1 GiB is not read: UNKNOWN with the reason', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.headBlobs['data.bin'] = blobOf('d'); w.watched['data.bin'] = 'd'
    await begun($); w.sizes['data.bin'] = 2 * FINGERPRINT_FILE_BYTES
    await stop($)
    unidentified(h, 'a tracked file is larger than 1 GiB')
  })
  test('more than 8 GiB to read in all is UNKNOWN, though each file is within its own bound', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = Array.from({ length: 9 }, (_, i) => `part${i}.bin`)
    for (const name of w.untracked) w.sizes[name] = FINGERPRINT_FILE_BYTES
    await stop($)
    unidentified(h, 'more than 8 GiB to read')
    expect(hashedPaths(w).filter(p => p.startsWith('part'))).toEqual([])
  })
  test('control: files within both bounds are read and measured', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = ['a.bin', 'b.bin']; w.sizes['a.bin'] = FINGERPRINT_FILE_BYTES; w.sizes['b.bin'] = 1024
    await stop($)
    expect(kept(h).at(-1)?.complete).toBe(true)
    expect(hashedPaths(w)).toContain('a.bin')
  })
  test('a listing cut short by the host\'s output limit is UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.gitTruncates = 'ls-files'
    await stop($)
    unidentified(h, 'cut short')
  })
  test('hashing that runs past the host\'s timeout is UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['slow.bin']; w.gitHangs = 'hash-object'
    await stop($)
    unidentified(h, 'git raised an error or timed out')
  })
  test('a whole measurement past its deadline is UNKNOWN, never a partial answer', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    w.untracked = Array.from({ length: 900 }, (_, i) => `gen/f${i}.ts`)
    w.duringRun = async argv => { if (argv[0] === 'stat' && argv.includes('-L') === false && argv.some(a => a.startsWith('./gen/'))) await w.clock.advance(31_000) }
    await stop($)
    unidentified(h, 'measuring the working tree took longer than 90s')
  })
})

describe('a file swapped while it is measured is not believed', () => {
  const swapDuringHash = (w: World, path: string, swap: () => void) => {
    let done = false
    w.duringRun = argv => { if (!done && argv[0] === 'git' && argv.includes('hash-object') && argv.some(a => a === path || a === `./${path}`)) { done = true; swap() } }
  }
  test('an untracked file replaced by a link to a device between inspection and read: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($); w.untracked = ['swap.txt']
    swapDuringHash(w, 'swap.txt', () => { w.kinds['swap.txt'] = 'link'; w.linkTargets['swap.txt'] = '/dev/zero' })
    await stop($)
    notBelieved(h, 'a file changed while it was being measured')
    // measured again once it settled: a link, by its text; what it leads to is never read
    expect(hashedPaths(w).filter(p => p === 'swap.txt')).toHaveLength(1)
  })
  test('a tracked file rewritten (new inode) while it is read: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on); w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    await begun($)
    swapDuringHash(w, 'src/a.ts', () => { w.inodes['src/a.ts'] = 99 })
    await stop($)
    notBelieved(h, 'a tracked file changed while it was being measured')
  })
  test('an excludes file replaced by a link to a device after it was checked: UNKNOWN', guard(), async ($, on) => {
    const { w, h } = fixture(on)
    await begun($)
    swapDuringHash(w, '/work/example/.git/info/exclude', () => { w.kinds['.git/info/exclude'] = 'link'; w.followKinds['.git/info/exclude'] = 'char' })
    await stop($)
    notBelieved(h, 'the excludes or attributes files: a file changed while it was being measured')
    unidentified(h, 'info/exclude is a character device')                         // and once it settled on a device, never measured
  })
  test('the release check: a changed file swapped while it is re-read is no candidate', { options: { orchestration: true, profile: 'SONNET_LED' } }, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('line\n'); w.watched.a = 'line\r\n'; w.normalized.a = 'line\n'; w.indexFlags = 'H a\0'
    w.duringRun = argv => { if (argv[0] === 'git' && argv.includes('hash-object') && !argv.includes('--no-filters')) w.inodes.a = (w.inodes.a ?? 1) + 1 }
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
})

describe('an unmeasurable tree never keeps a goal check or a passing check', () => {
  const aligned = { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [{ id: 'c1', evidence: "cancel test 'frees the slot' passes in test/api.test.js (4 pass)" }] } }
  const toDone = async ($: any) => {
    await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    expect(await progress($, aligned)).toContain('alignment ALIGNED')
    expect(await progress($, { action: 'complete', milestone: 'm5' })).toStartWith('DONE 100%')
  }
  const unmeasurable = (w: World) => { w.gitConfig['core.excludesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
  test('DONE on a measured tree is withdrawn when the tree can no longer be measured', async ($, on) => {
    const w = world(on); await toDone($)
    unmeasurable(w)
    const status = await progress($, { action: 'status' })
    expect(status).not.toStartWith('DONE')
    expect(status).toContain('TEST pending')
  })
  test('a transient failure counts the same: it is not a clean tree', async ($, on) => {
    const w = world(on); await toDone($)
    w.gitHangs = 'diff'
    expect(await progress($, { action: 'status' })).not.toStartWith('DONE')
  })
  test('control: a measured tree that did not change keeps DONE', async ($, on) => {
    world(on); await toDone($)
    expect(await progress($, { action: 'status' })).toStartWith('DONE 100%')
  })
  test('align is refused when the checks were observed on a measured tree and the tree can no longer be measured', async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    unmeasurable(w)
    const refused = await progress($, aligned)
    expect(refused).toStartWith('error: ALIGNED refused')
    expect(refused).toContain('the working tree can no longer be measured (core.excludesFile is a character device')
    expect(await progress($, { action: 'status' })).toContain('TEST pending')
    // checks observed again on the unmeasurable tree: the goal check is accepted, and says why later changes cannot be seen
    await passAllGates($, { align: false })
    const accepted = await progress($, aligned)
    expect(accepted).toContain('alignment ALIGNED')
    expect(accepted).toContain('No working-tree fingerprint could be taken here (core.excludesFile is a character device')
  })
  test('a passing command seen on an unmeasurable tree stales the checks observed on a measured one', async ($, on) => {
    const w = world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    w.gitHangs = 'diff'                                                            // nothing measurable changed: only measuring failed
    await bash($, 'npm test')
    const status = await progress($, { action: 'status' })
    expect(status).toContain('CODE pending')
  })
  test('control: a passing command on the same measured tree keeps the other checks', async ($, on) => {
    world(on); await start($)
    await prompt($, 'Add booking cancellation to the API and the UI')
    await progress($, { action: 'discover', criteria: ['A booking can be cancelled'] })
    await planAndComplete($, 4)
    await passAllGates($, { align: false })
    await bash($, 'npm test')
    expect(await progress($, { action: 'status' })).toContain('CODE pass')
  })
})

describe('ordinary repositories keep working', () => {
  const ordinary = (w: World) => {
    w.headBlobs['src/a.ts'] = blobOf('a'); w.watched['src/a.ts'] = 'a'
    w.headBlobs['src/b.ts'] = blobOf('b'); w.watched['src/b.ts'] = 'b'
    w.headBlobs['docs/current'] = blobOf('v1.md'); w.headModes['docs/current'] = '120000'; w.kinds['docs/current'] = 'link'; w.linkTargets['docs/current'] = 'v1.md'
    w.untracked = ['scratch.md']; w.kinds['latest'] = 'link'
    w.ignoredEntries = ['.cache/x']
  }
  test('control: a repository with tracked, linked, untracked and ignored files measures the same twice', guard(), async ($, on) => {
    const { w } = fixture(on); ordinary(w)
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    expect(checks(w)).toBe(0)
  })
  for (const [what, change] of [
    ['a modified tracked file', (w: World) => { w.watched['src/a.ts'] = 'changed' }],
    ['a deleted tracked file', (w: World) => { w.kinds['src/b.ts'] = 'missing' }],
    ['a new untracked file', (w: World) => { w.untracked.push('new.ts') }],
    ['a retargeted tracked link', (w: World) => { w.linkTargets['docs/current'] = 'v2.md' }],
    ['a new untracked link to a regular file', (w: World) => { w.untracked.push('latest') }],
  ] as const) {
    test(`${what} is a change, measured`, guard(), async ($, on) => {
      const { w, h } = fixture(on); ordinary(w)
      await begun($); change(w)
      await stop($)
      expect(checks(w)).toBe(1)
      expect(kept(h).at(-1)?.complete).toBe(true)
    })
  }
  test('a session in a subdirectory of the work tree measures the whole tree', guard(), async ($, on) => {
    const { w, h } = fixture(on); ordinary(w); w.cwd = '/work/example/src'; w.gitPrefix = 'src/'
    await begun($); w.watched['src/a.ts'] = 'changed'
    await stop($)
    expect(checks(w)).toBe(1)
    expect(kept(h).at(-1)?.complete).toBe(true)
  })
  test('a BSD stat answers the same inspection through -f', guard(), async ($, on) => {
    const { w, h } = fixture(on); ordinary(w); w.statFlavor = 'bsd'
    await begun($)
    expect((await stop($)).block).toBeUndefined()
    await prompt($, 'again'); w.watched['src/a.ts'] = 'changed'
    await stop($)
    expect(checks(w)).toBe(1)
    expect(kept(h).at(-1)?.complete).toBe(true)
  })
  for (const device of [false, true]) {
    test(`the HUD's status refresh ${device ? 'does not start while an attributes file is a device' : 'reads an ordinary repository (control)'}`, async ($, on) => {
      const w = world(on); w.gitStatus = CLEAN_REPO
      await start($); await prompt($, 'look around')
      if (device) { w.gitConfig['core.attributesFile'] = '/dev/zero'; w.kinds['/dev/zero'] = 'char' }
      const from = w.runs.length
      await bash($, 'ls')                                                          // a tool call schedules the refresh
      await w.clock.advance(1_000)
      await progress($, { action: 'status' })
      expect(gitSubcommands(w, from).filter(s => s === 'status')).toEqual(device ? [] : ['status'])
    })
  }
})

const PACKET = { action: 'consult', ground: 'release', objective: 'Release v0.6.4', architecture: 'Plugin hooks', locations: ['hooks/register.tsx'], risk: 'Candidate mismatch', question: 'Approve the release?' }
async function admit($: Parameters<typeof start>[0]): Promise<string> {
  await start($); await prompt($, 'Have Opus review the release candidate')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const milestone of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone })
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'na', evidence: 'fixture' })
  return String((await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', ...PACKET } as never)).result)
}
