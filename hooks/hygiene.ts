// Repository hygiene: finding AI attribution in text about to enter a
// repository, and instruction files (CLAUDE.md, AGENTS.md) about to be
// created. Detection only; register.tsx decides what to do with a finding.

import { basename, parseShell, unwrap } from './shell'

export type Attribution = {
  /**
   * `trailer`: unmistakable attribution (a Co-authored-by naming an AI, the
   * "Generated with Claude Code" footer). `phrase`: a standalone line that
   * reads as attribution but could be the project's own copy.
   */
  kind: 'trailer' | 'phrase'
  /** The offending line, trimmed. */
  line: string
}

const AI =
  '(?:claude(?:\\s+code)?|anthropic|chat\\s?gpt|openai|gpt-?\\d[\\w.-]*|codex|copilot|gemini|cursor|aider|devin|windsurf|codeium|an?\\s+ai(?:\\s+(?:assistant|agent|model|tool))?|ai(?:\\s+(?:assistant|agent))?|llm)'

/** Names that are also people's: a trailer is an AI's only when nothing like a surname follows. */
const AI_NAME = '(?:claude|gemini|devin|cursor|aider|codex|copilot|windsurf|codeium)'
const AI_SURE =
  '(?:anthropic|chat\\s?gpt|openai|gpt-?\\d[\\w.-]*|github\\s+copilot|claude\\s+code|ai\\s+(?:assistant|agent)|an?\\s+ai)'
const AFTER_AI_NAME = '(?=\\s*<|\\s*$|\\s+(?:code|opus|sonnet|haiku|fable|ai|assistant|agent|bot|\\d|\\())'

const TRAILERS: readonly RegExp[] = [
  new RegExp(
    `^\\W*(co-authored-by|signed-off-by|assisted-by|generated-by|authored-by)\\s*:\\s*(?:.*\\b${AI_SURE}\\b|(?:.*\\s)?${AI_NAME}${AFTER_AI_NAME})`,
    'i',
  ),
  /noreply@anthropic\.com/i,
  /\u{1F916}\s*generated\s+(with|by)\b/iu,
  /\bgenerated\s+(with|by)\s+\[?claude\s+code\]?/i,
]

/** A line that opens with the attribution and says little else. */
const PHRASE = new RegExp(
  `^\\W*(?:this\\s+\\w+\\s+(?:was|is)\\s+)?(?:(?:code|commit|file|content|pr)\\s+)?(?:auto-?)?(generated|written|created|authored|built|made|produced|coded|drafted)\\s+(?:entirely\\s+|partly\\s+|partially\\s+|in\\s+part\\s+)?(with|by|using)\\s+(?:the\\s+help\\s+of\\s+)?${AI}\\b`,
  'i',
)
const TAG = /^\W*ai[- ](generated|assisted|authored|written)\b\W*$/i
const MAX_PHRASE_LINE = 90

const attributionOfLine = (line: string): Attribution | null => {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (TRAILERS.some(pattern => pattern.test(trimmed))) return { kind: 'trailer', line: trimmed }
  if (trimmed.length <= MAX_PHRASE_LINE && (PHRASE.test(trimmed) || TAG.test(trimmed))) {
    return { kind: 'phrase', line: trimmed }
  }

  return null
}

/** Every line of `text` that attributes the work to an AI. */
export const findAttribution = (text: string): Attribution[] =>
  text
    .split(/\r?\n|\\n/)
    .map(attributionOfLine)
    .filter((one): one is Attribution => one !== null)

/** The attribution `after` holds that `before` did not: what an edit adds. */
export const addedAttribution = (before: string, after: string): Attribution[] => {
  const known = new Map<string, number>()
  for (const one of findAttribution(before)) known.set(one.line, (known.get(one.line) ?? 0) + 1)

  return findAttribution(after).filter(one => {
    const left = known.get(one.line) ?? 0
    if (left === 0) return true
    known.set(one.line, left - 1)

    return false
  })
}

const GIT_WRITERS = new Set(['commit', 'merge', 'tag', 'notes', 'revert', 'cherry-pick', 'am', 'commit-tree', 'rebase'])
const GH_WRITERS = /^(pr|issue|release)\s+(create|edit|comment|review|merge)\b/

/**
 * Attribution in a command that writes a commit, tag or pull request.
 * `git log --grep` and `grep` over the same words write nothing and pass.
 */
export const attributionInCommand = (command: string): Attribution[] => {
  const isWriter = (argv: readonly string[]): boolean => {
    const run = unwrap(argv)
    if (run === null) return false
    if (run.program === 'git') {
      const sub = run.args.find(
        (arg, index) => !arg.startsWith('-') && run.args[index - 1] !== '-C' && run.args[index - 1] !== '-c',
      )

      return sub !== undefined && GIT_WRITERS.has(sub)
    }
    if (run.program === 'gh' || run.program === 'glab') return GH_WRITERS.test(run.args.join(' '))

    return run.program === 'jj' && /^(describe|commit|new)\b/.test(run.args.join(' '))
  }
  // every word of a pipeline that writes: the message may be piped in, passed
  // as its own `-m`, or sit in a here-document
  const texts = parseShell(command)
    .pipelines.filter(pipeline => pipeline.commands.some(simple => isWriter(simple.argv)))
    .flatMap(pipeline => pipeline.commands.flatMap(simple => [...simple.argv, simple.heredoc ?? '']))
  const seen = new Set<string>()

  return texts.flatMap(findAttribution).filter(one => {
    if (seen.has(one.line)) return false
    seen.add(one.line)

    return true
  })
}

const INSTRUCTION_FILES = new Set(['claude.md', 'agents.md'])

export const isInstructionFile = (path: string): boolean =>
  INSTRUCTION_FILES.has(basename(path.replace(/\\/g, '/')).toLowerCase())

/**
 * Where cp, mv, install and ln put things. The last word is the destination; when it is a directory (`.`, `..`, a trailing
 * slash, or the value of `-t`/`--target-directory`) each source lands inside it under its own name,
 * so a source called CLAUDE.md creates `<directory>/CLAUDE.md`. A lone `ln` target links into the current directory. A bare word that names a directory (`cp CLAUDE.md sub`) cannot be told from a file name and is read as a file.
 */
const copiedTo = (program: string, args: readonly string[], paths: readonly string[]): string[] => {
  const flag = args.findIndex(arg => arg === '-t' || arg.startsWith('--target-directory'))
  const inline = flag >= 0 ? args[flag]!.split('=')[1] : undefined
  const target = flag < 0 ? undefined : inline ?? args[flag + 1]
  const sources = target === undefined ? paths.slice(0, -1) : paths.filter(path => path !== target)
  const dest = target ?? (paths.length > 1 ? paths[paths.length - 1] : program === 'ln' && paths.length === 1 ? '.' : undefined)
  if (dest === undefined) return []
  const named = (path: string): string => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  const isDirectory = target !== undefined || dest === '.' || dest === '..' || dest.endsWith('/')
  const lone = target === undefined && paths.length === 1 ? paths : sources

  return [dest, ...(isDirectory ? lone.filter(isInstructionFile).map(source => `${dest.replace(/\/+$/, '')}/${named(source)}`) : [])]
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/** The instruction files a shell command would write: redirects, tee, touch, truncate, cp, mv, install, ln, dd, and a script handed to a shell or eval. */
export const instructionFilesWritten = (command: string, depth = 0): string[] => {
  const written: string[] = []
  for (const pipeline of parseShell(command).pipelines) {
    for (const simple of pipeline.commands) {
      written.push(...simple.writes)
      const run = unwrap(simple.argv)
      if (run === null) continue
      const paths = run.args.filter(arg => !arg.startsWith('-'))
      if (run.program === 'touch' || run.program === 'tee' || run.program === 'truncate') written.push(...paths)
      if (['cp', 'mv', 'install', 'ln'].includes(run.program)) written.push(...copiedTo(run.program, run.args, paths))
      if (run.program === 'dd') written.push(...run.args.filter(arg => arg.startsWith('of=')).map(arg => arg.slice(3)))
      // a script handed to a shell (`-c`, and clusters that end in it) or to eval is read too
      if (depth < 4 && run.program === 'eval') written.push(...instructionFilesWritten(run.args.join(' '), depth + 1))
      // a script piped into a bare shell: the words of the commands feeding it are read as the script
      if (depth < 4 && SHELLS.has(run.program) && !run.args.some(arg => /^-[A-Za-z]*c$/.test(arg)) && pipeline.commands.length > 1 && simple === pipeline.commands[pipeline.commands.length - 1]) {
        for (const feeder of pipeline.commands.slice(0, -1)) written.push(...instructionFilesWritten(`${feeder.argv.slice(1).join(' ')}\n${feeder.heredoc ?? ''}`, depth + 1))
      }
      if (depth < 4 && SHELLS.has(run.program)) {
        const flag = run.args.findIndex(arg => /^-[A-Za-z]*c$/.test(arg))
        if (flag >= 0) written.push(...instructionFilesWritten(run.args[flag + 1] ?? '', depth + 1))
        if (simple.heredoc !== null) written.push(...instructionFilesWritten(simple.heredoc, depth + 1))
      }
    }
  }

  return [...new Set(written.filter(isInstructionFile))]
}
