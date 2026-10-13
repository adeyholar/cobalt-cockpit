// How a filesystem path is shown: shortened to what tells paths apart, and without the name of a personal directory.
//
// A home directory names a person. The patterns below are the layouts recognised as "the next segment is a user's name";
// that segment is never shown, however deep the path. This is pattern matching over text, not anonymization: a layout that
// is not listed, a user name with a space in it, a UNC share and a path quoted inside other text in some unusual way are
// shown as any other path is (its last two segments). What is recognised and what is not is listed in PRIVACY.md.

/** Leading segments after which the next one is a user's name. `*` is any one segment, `?` a single drive letter. */
const HOME_PREFIXES: readonly (readonly string[])[] = [
  ['home'],                                   // Linux
  ['Users'],                                  // macOS
  ['var', 'home'],                            // Fedora Atomic / immutable desktops, where /home is a link to /var/home
  ['usr', 'home'],                            // FreeBSD
  ['export', 'home'],                         // Solaris, NFS exports
  ['mnt', '*', 'Users'],                      // WSL: /mnt/c/Users/<name>
  ['?', 'Users'],                             // Git Bash / MSYS: /c/Users/<name>
  ['cygdrive', '?', 'Users'],                 // Cygwin
  ['Volumes', '*', 'Users'],                  // macOS, another volume
  ['System', 'Volumes', 'Data', 'Users'],     // macOS, the data volume
  ['System', 'Volumes', 'Data', 'home'],
  ['media'],                                  // removable media mounted per user: /media/<name>/<label>
  ['run', 'media'],                           // the same under /run
]
const matches = (parts: readonly string[], prefix: readonly string[]): boolean =>
  parts.length > prefix.length && prefix.every((want, i) => want === '*' || (want === '?' ? /^[A-Za-z]$/.test(parts[i] as string) : parts[i] === want))

/** The segments below a personal directory, when the path is inside one; null when it is not a recognised home layout. */
export const personalRest = (parts: readonly string[]): string[] | null => {
  const prefix = HOME_PREFIXES.find(p => matches(parts, p))

  return prefix === undefined ? null : parts.slice(prefix.length + 1)
}

const lastTwo = (parts: readonly string[]): string => `…/${parts.slice(-2).join('/')}`
/** Segments as shown: nothing of a home directory but what lies below it, and at most the last two. */
const shortOf = (parts: readonly string[], whole: string): string => {
  const rest = personalRest(parts)
  if (rest !== null) return rest.length === 0 ? '…/' : lastTwo(rest)

  return parts.length <= 2 ? whole : lastTwo(parts)
}

const SEG = '[^\\s/\'"`]'
const WIN = '[^\\s\\\\/\'"`]'
// One pass, four shapes: a file URL's path; a drive-letter path with either slash; another person's home by name
// (~name/…); and a path that is absolute or relative to ~, . or ... A path after a word character or a slash is left
// alone, which is what keeps the path of a web URL (https://host/a/b) and a relative path (hooks/a.ts) untouched;
// `host:/path` is a path and is shortened.
const PATHS = new RegExp(
  `file://(?:localhost)?(/(?:${SEG}+/)*${SEG}*)` +
  `|(?<![\\w/\\\\])[A-Za-z]:[\\\\/]((?:${WIN}+[\\\\/])+${WIN}*)` +
  `|(?<![\\w/])~[A-Za-z_][\\w.-]*(/(?:${SEG}+/)*${SEG}*)` +
  `|(?<![\\w/])(?:~|\\.{1,2})?(/(?:${SEG}+/)+${SEG}*)`,
  'g',
)
const segments = (text: string, separator: RegExp): string[] => text.split(separator).filter(p => p !== '' && p !== '.' && p !== '..')

/** Free text written by the commander or an agent, with any path in it cut to its last two segments, as claims are. */
export const shortenPaths = (text: string): string => text.replace(PATHS, (m: string, url: string | undefined, drive: string | undefined, other: string | undefined, path: string | undefined) => {
  if (url !== undefined) return `file://${shortOf(segments(url, /\//), url)}`
  if (drive !== undefined) {
    // C:\Users\<name>\… and C:/Users/<name>/…: the same rule as /c/Users/<name>
    const parts = segments(drive, /[\\/]/)

    return parts[0] === 'Users' && parts.length > 1 ? (parts.length === 2 ? '…/' : lastTwo(parts.slice(2))) : parts.length <= 2 ? m : lastTwo(parts)
  }
  if (other !== undefined) {
    // ~name is another person's home by name: only what lies below it is shown
    const parts = segments(other, /\//)

    return parts.length === 0 ? '…/' : lastTwo(parts)
  }
  const parts = segments(path as string, /\//)
  // relative to ~, . or ..: no name is in it, so it is only shortened
  if (!m.startsWith('/')) return parts.length <= 2 ? m : lastTwo(parts)

  return shortOf(parts, m)
})

/** A resource claim shortened to its last two segments: the claim is the commander's, and a long path is not needed to tell claims apart. */
export const shortResource = (r: string): string => {
  if (r === '*') return 'the whole repository'
  const parts = r.split('/').filter(p => p !== '')
  const rest = personalRest(parts)
  if (rest !== null) return rest.length === 0 ? '…/' : lastTwo(rest)

  return parts.length <= 2 ? `/${parts.join('/')}` : lastTwo(parts)
}

/**
 * A whole path with only the personal directory's name left out: `/var/home/<name>/x/y` → `/var/home/…/x/y`. For a
 * diagnostic whose point is the path itself (where a plugin is loaded from), where cutting to two segments would lose it.
 */
export const withoutHomeName = (path: string): string => {
  const parts = path.split('/').filter(p => p !== '')
  const rest = path.startsWith('/') ? personalRest(parts) : null
  if (rest === null) return path
  const prefix = parts.slice(0, parts.length - rest.length - 1)

  return `/${[...prefix, '…', ...rest].join('/')}`
}
