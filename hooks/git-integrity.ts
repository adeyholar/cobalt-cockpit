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

// --- Bounded measurement (v0.6.4) ---
// A repository decides what Git and the inspection tools read: a link to /dev/zero among the untracked files, an
// excludes, attributes, order or alternates file pointed at a device, a FIFO where Git expects a file. Read whole,
// those exhausted memory within seconds or blocked until the host's timeout (measured). The host bounds a process's
// time, not its memory, so every measurement process starts through a constant script that sets kernel limits and
// then replaces itself with the real command. The command's own words are passed as separate arguments, never
// interpolated into the script.

/** Address space of one measurement process, in KiB (1 GiB). Measured: every fingerprint command fits in 384 MiB with GIT_BOUNDED. */
export const BOUND_AS_KIB = 1_048_576
/** CPU seconds of one measurement process; the host's timeout normally ends it long before. */
export const BOUND_CPU_S = 20
/** The script's $0, which also tells a reader (and the test host) that the command after it is bounded. */
export const BOUND_TAG = 'cockpit-bounded'
/**
 * Most a measurement process may write to one regular file, in 512-byte blocks (64 MiB; a shell that counts 1024-byte blocks
 * allows 128 MiB). Not 0: where a host captures output through a file, 0 would end every measurement on its first write
 * (measured). Git's own measurement commands write nothing.
 */
export const BOUND_FILE_BLOCKS = 131_072
/**
 * Lowers a limit to a value, and never raises one: a host or container whose limit is already stricter keeps it (raising a hard
 * limit is refused, which made every `ulimit` fail under a stricter outer limit; measured).
 */
const LOWER = 'lower() { c=$(ulimit "$1") || return 1; if [ "$c" = unlimited ] || [ "$c" -gt "$2" ]; then ulimit "$1" "$2"; fi; }'
const LIMITS = (memory: boolean): string => `${LOWER} && ${memory ? `lower -v ${BOUND_AS_KIB} && ` : ''}lower -t ${BOUND_CPU_S} && lower -f ${BOUND_FILE_BLOCKS} && lower -c 0`
/** CPU, file size and no core dump; with `memory`, the address space too. Then the command, by exec, as its own words. */
export const boundScript = (memory: boolean): string => `${LIMITS(memory)} && exec "$@"`
/** Probes, once a session: are the limits accepted, and is the memory cap actually enforced (a 64 MiB allocation under 32 MiB must fail, and succeed without it)? */
export const BOUND_PROBE_SET = (memory: boolean): string => `${LIMITS(memory)} && echo set`
export const BOUND_PROBE_CONTROL = 'exec dd if=/dev/zero of=/dev/null bs=67108864 count=1'
export const BOUND_PROBE_CAPPED = `${LOWER} && lower -v 32768 && exec dd if=/dev/zero of=/dev/null bs=67108864 count=1`
/** No repository hooks, and no diff order file (read whole by status, diff and log; one pointed at a device exhausted memory). Also on a helper's rebuilt Git inspection. */
export const GIT_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.orderFile=/dev/null']
/**
 * Git settings that keep a legitimate command inside the cap: small pack windows, streaming for files over 16 MiB, no index
 * threads, no hooks, and no diff order file (status and diff read a configured one whole; measured: one pointed at a device
 * exhausted memory; the order of a listing never matters here).
 */
export const GIT_BOUNDED = [...GIT_OVERRIDES, '-c', 'core.packedGitWindowSize=32m', '-c', 'core.packedGitLimit=256m', '-c', 'core.deltaBaseCacheLimit=64m', '-c', 'core.bigFileThreshold=16m', '-c', 'core.preloadIndex=false', '-c', 'index.threads=1']
/** glibc reserves address space per malloc arena; two keep a bounded Git well inside its cap. */
export const BOUND_ENV = { MALLOC_ARENA_MAX: '2' }

/** One working-tree file the fingerprint reads, and all of them together, at most; beyond either, the tree is UNKNOWN. */
export const FINGERPRINT_FILE_BYTES = 1024 ** 3
export const FINGERPRINT_TOTAL_BYTES = 8 * 1024 ** 3
/** An excludes or attributes file Git reads whole must be a regular file of at most this. */
export const SOURCE_BYTES = 1024 * 1024

export type Kind = 'file' | 'link' | 'dir' | 'fifo' | 'socket' | 'char' | 'block' | 'missing'
/**
 * What `stat` (or `stat -L`) said about one path: its kind, its size, and an identity that moves when the file is replaced or
 * rewritten. `name` is the path the record answers for, where the form carries it (GNU).
 */
export type Inspected = { kind: Kind; mode: number; size: number; identity: string; name?: string }

export const kindOfMode = (mode: number): Kind | null => {
  switch (mode & 0o170000) {
    case 0o100000: return 'file'
    case 0o120000: return 'link'
    case 0o040000: return 'dir'
    case 0o010000: return 'fifo'
    case 0o140000: return 'socket'
    case 0o020000: return 'char'
    case 0o060000: return 'block'
    default: return null
  }
}
/**
 * GNU `stat --printf` and BSD `stat -f` forms of the same five facts: raw mode, size, inode, modification and change time. The
 * GNU form also carries the name asked for, so a batch in which some paths failed still answers for the others.
 */
export const INSPECT_GNU = '%f %s %i %.9Y %.9Z %n\\0'
export const INSPECT_BSD = '%p %z %i %m %c'
/** Parses one record of either form; null for anything malformed. */
export const inspectedOf = (record: string, gnu: boolean): Inspected | null => {
  const m = gnu ? /^([0-9a-f]+) (\d+) (\d+) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) ([\s\S]+)$/.exec(record) : /^([0-7]+) (\d+) (\d+) (\d+) (\d+)$/.exec(record)
  if (!m) return null
  const mode = parseInt(m[1]!, gnu ? 16 : 8)
  const kind = kindOfMode(mode)
  const size = Number(m[2])
  if (kind === null || !Number.isSafeInteger(size)) return null
  return { kind, mode, size, identity: `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}`, ...(gnu ? { name: m[6]! } : {}) }
}
