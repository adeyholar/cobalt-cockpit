// Authoritative tracked-content evidence comes from the commit tree and the disk, never the index's stat cache.

export const GIT_SAFE = ['--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'diff.ignoreSubmodules=none', '-c', 'status.submoduleSummary=false', '-c', 'core.checkStat=default', '-c', 'core.trustctime=true', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium']
export const TRACKED_LIMIT = 100_000
export type CommitEntry = { path: string; oid: string; mode: '100644' | '100755' | '120000' | '160000' }
export type DiskEntry = CommitEntry & { raw: string; isSameType: boolean; diskMode?: string }
export type Measurement = { entries: DiskEntry[] } | { why: string }

export const commitEntries = (text: string): CommitEntry[] | null => {
  if (text !== '' && !text.endsWith('\0')) return null
  const out: CommitEntry[] = [], seen = new Set<string>()
  for (const record of text.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record)
    if (!match) return null
    const [, mode, kind, oid, path] = match
    if (!path || path.startsWith('/') || path.split('/').some(p => p === '' || p === '.' || p === '..') || seen.has(path) || (mode === '160000') !== (kind === 'commit')) return null
    seen.add(path)
    out.push({ path, oid: oid!, mode: mode as CommitEntry['mode'] })
    if (out.length > TRACKED_LIMIT) return null
  }
  return out
}
