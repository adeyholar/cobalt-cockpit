// Defensive candidate identity: unknown evidence never approves a release.
import { describe, expect, test } from 'claude-code/testing'
import { activeFilter, filterCommands } from '../hooks/git'
import { commitEntries } from '../hooks/git-integrity'
import { blobOf, FIVE, GATE_NAMES, hostState, progress, prompt, start, world } from './world'

const LED = { options: { orchestration: true, profile: 'SONNET_LED' } }
const PACKET = { action: 'consult', ground: 'release', objective: 'Release v0.5.3', architecture: 'Plugin hooks', locations: ['hooks/git.ts'], risk: 'Candidate mismatch', question: 'Approve the release?' }
const filter = 'filter.hide.clean\nprintf original\0'
const attrs = 'a\0filter\0hide\0'
const admit = async ($: Parameters<typeof start>[0]) => {
  await start($); await prompt($, 'Have Opus review the release candidate')
  await progress($, { action: 'plan', milestones: FIVE })
  for (const milestone of ['m1', 'm2', 'm3', 'm4']) await progress($, { action: 'complete', milestone })
  for (const gate of GATE_NAMES) await progress($, { action: 'gate', gate, state: 'na', evidence: 'fixture' })
  return String((await $.tool.call({ tool: 'mcp__cobalt-cockpit__swarm', ...PACKET } as never)).result)
}

describe('Git filter evidence parsing', () => {
  test('effective command wins; empty commands and dormant drivers are safe', () => {
    expect([...filterCommands(`${filter}filter.hide.clean\n\0`)!]).toEqual([])
    expect([...filterCommands('filter.lfs.process\ngit-lfs filter-process\0')!]).toEqual(['lfs'])
    expect(activeFilter('a\0filter\0unspecified\0', new Set(['lfs']), 'a\0')).toBe(false)
    expect(activeFilter(attrs, new Set(['hide']), 'a\0')).toBe(true)
  })
  test('missing, malformed and reordered output never proves reliability', () => {
    for (const output of ['filter.hide.clean', 'filter.hide.clean\0', 'bad\ncommand\0']) expect(filterCommands(output)).toBeNull()
    for (const output of ['', 'a\0filter\0', 'a\0other\0hide\0', 'b\0filter\0unspecified\0']) expect(activeFilter(output, new Set(['hide']), 'a\0')).toBeNull()
  })
})

describe('release candidate preflight through the host', () => {
  test('actual tracked bytes disagree with the commit despite all cached listings reporting clean: no admission', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.watched.a = 'changed bytes'
    w.indexFlags = 'H a\0'; w.statDirty = []; w.uncommitted = false
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('a commit path omitted by the cached index is still measured', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.watched.a = 'changed bytes'; w.indexFlags = ''
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('ordinary clean bytes remain eligible independent of cached stat information', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.watched.a = 'original'; w.indexFlags = 'H a\0'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('native EOL normalization remains eligible, while raw measurement retains the bytes', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('line\n'); w.watched.a = 'line\r\n'; w.normalized.a = 'line\n'; w.indexFlags = 'H a\0'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('a tracked special file is UNKNOWN rather than trusted from status', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.diskModes.a = 0x1000
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('unreadable tracked bytes are UNKNOWN', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.gitHangs = 'hash-object'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('ordinary tracked symbolic links remain eligible using their target bytes', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('target'); w.headModes.a = '120000'; w.diskModes.a = 0xa1ff
    w.outputs.readlink = () => 'target\0'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('core.symlinks=false checkouts remain eligible with literal target bytes', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('target'); w.headModes.a = '120000'; w.watched.a = 'target'; w.gitConfig['core.symlinks'] = 'false'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  for (const filemode of ['true', 'false']) test(`executable mode comparison honors core.filemode=${filemode}`, LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.watched.a = 'original'; w.headModes.a = '100755'; w.gitConfig['core.filemode'] = filemode
    const admitted = (await admit($)).includes('OPUS ADMITTED')
    expect(admitted).toBe(filemode === 'false')
  })
  test('a root ending in whitespace remains distinct from its sibling', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.cwd = '/work/example '; w.top = '/work/example'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('a valid root containing trailing whitespace remains supported', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.cwd = '/work/example '; w.top = w.cwd
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  for (const truncated of [false, true]) test(`incomplete clean status (stderr truncated: ${truncated}) is UNKNOWN`, LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.statusWarning = truncated ? '' : "warning: could not open directory 'secret-dir/': Permission denied"
    w.statusStderrTruncated = truncated
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  for (const driver of ['clean', 'process']) {
    test(`an active ${driver} filter with clean status and a refreshed ordinary index is UNKNOWN before status`, LED, async ($, on) => {
      const w = world(on); hostState(on, {})
      w.gitFilterConfig = `filter.hide.${driver}\nexternal command\0`; w.gitFilterAttributes = attrs; w.indexFlags = 'H a\0'
      // Reproduced with real git: add runs a normalizing filter, then status and ls-files -m are empty.
      w.uncommitted = false; w.statDirty = []
      expect(await admit($)).not.toContain('OPUS ADMITTED')
      expect(w.runs.some(argv => argv.includes('status') && argv.includes('--porcelain'))).toBe(false)
    })
  }
  test('global LFS configuration without an active attribute remains a valid ordinary repository', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.gitFilterConfig = 'filter.lfs.clean\ngit-lfs clean -- %f\0'; w.gitFilterAttributes = 'a\0filter\0unspecified\0'; w.indexFlags = 'H a\0'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('a clean filter with an explicit empty effective command remains valid', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.gitFilterConfig = `${filter}filter.hide.clean\n\0`; w.gitFilterAttributes = attrs; w.indexFlags = 'H a\0'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('a redirected clean worktree cannot approve the intended directory', LED, async ($, on) => {
    const w = world(on); hostState(on, {}); w.top = '/work/clean-copy'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('a valid session inside a repository subdirectory remains valid', LED, async ($, on) => {
    const w = world(on); hostState(on, {}); w.top = '/work'; w.gitPrefix = 'example/'
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  test('a valid linked worktree (matching top and session directory) remains valid', LED, async ($, on) => {
    world(on); hostState(on, {})
    expect(await admit($)).toContain('OPUS ADMITTED')
  })
  for (const tag of ['h', 'S', 's']) test(`index flag ${tag} cannot hide a tracked modification`, LED, async ($, on) => {
    const w = world(on); hostState(on, {}); w.indexFlags = `${tag} a\0`
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('an unreadable effective configuration never approves a candidate', LED, async ($, on) => {
    const w = world(on); hostState(on, {}); w.gitHangs = 'config'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
})

describe('authoritative commit-tree evidence', () => {
  test('malformed, duplicate, unsupported or outside-root entries are rejected', () => {
    const oid = 'a'.repeat(40)
    for (const entry of [`100644 blob ${oid}\ta`, `100644 blob ${oid}\t../a\0`, `100644 blob ${oid}\ta\0`.repeat(2), `160000 blob ${oid}\ta\0`, `100644 blob invalid\ta\0`]) expect(commitEntries(entry)).toBeNull()
    expect(commitEntries(`100644 blob ${oid}\ta\0`)?.[0]?.path).toBe('a')
  })
  test('a submodule without independent nested verification is UNKNOWN', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.child = w.head; w.headModes.child = '160000'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
  test('changing a file to a link cannot match an ordinary committed file', LED, async ($, on) => {
    const w = world(on); hostState(on, {})
    w.headBlobs.a = blobOf('original'); w.diskModes.a = 0xa1ff
    w.outputs.readlink = () => 'target\0'
    expect(await admit($)).not.toContain('OPUS ADMITTED')
  })
})
