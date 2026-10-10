// Prompt-cache policy for subagents: what the configuration asks for, read
// from the places Claude Code itself reads, in Claude Code's own order. This is
// intent, never an observation: whether a request really wrote a 5-minute or a
// 1-hour entry is the host's, and its usage report does not split the two, so
// the effect stays UNKNOWN here. Nothing in this file writes a setting, sets a
// variable or makes a request; a recommendation is text for the owner to act on.
//
// The order is Claude Code 2.1.296's own, for a request that is not the main
// conversation (a subagent, workflow, background or helper request):
//   1. FORCE_PROMPT_CACHING_5M truthy            -> 5m, over everything below
//   2. CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL    -> "5m" | "1h"
//   3. settings `subagentPromptCacheTtl`        -> "5m" | "1h" (any other value, such as the number 60, is ignored)
//   4. the agent's own `cacheTtl` frontmatter   -> "5m" | "1h" ("1h" ignored in subscription overage)
//   5. ENABLE_PROMPT_CACHING_1H truthy          -> 1h
//   6. nothing set                              -> automatic: 5 minutes for subagents
// Cockpit's own agents declare no `cacheTtl` (a test holds that), so step 4 is
// reported as "per agent, not read here".

export const MIN_CACHE_VERSION: readonly number[] = [2, 1, 242]
export const LONG_RUNNING_MS = 5 * 60_000

export type CacheInput = {
  /** The host's base version, or null when unknown. */
  version: string | null
  /** Raw values: only these four environment variables and one setting are ever read. */
  forceFiveMinute: string | undefined
  envTtl: string | undefined
  settingTtl: unknown
  enableOneHour: string | undefined
}
export type CacheSource = 'force_5m_env' | 'env' | 'setting' | 'enable_1h_env' | 'default' | 'unsupported'
export type CacheReading = {
  /** null: the version is unknown, so support is unverified. */
  supported: boolean | null
  /** The TTL the configuration asks of subagents; `auto` is the host's own default (5 minutes). */
  ttl: '5m' | '1h' | 'auto'
  source: CacheSource
  notes: string[]
}

const atLeast = (version: string, floor: readonly number[]): boolean => {
  const parts = version.split(/[.-]/).map(Number)
  for (let at = 0; at < floor.length; at++) {
    const have = parts[at] ?? 0
    const want = floor[at] ?? 0
    if (Number.isNaN(have)) return false
    if (have !== want) return have > want
  }

  return true
}
const truthy = (raw: string | undefined): boolean | null => {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  if (['', '0', 'false', 'no', 'off'].includes(v)) return false
  if (['1', 'true', 'yes', 'on'].includes(v)) return true

  return null
}
const ttlOf = (x: unknown): '5m' | '1h' | null => (x === '5m' || x === '1h' ? x : null)

export const readCache = (i: CacheInput): CacheReading => {
  const notes: string[] = []
  const supported = i.version === null ? null : atLeast(i.version, MIN_CACHE_VERSION)
  if (supported === false) return { supported, ttl: 'auto', source: 'unsupported', notes: [`Claude Code ${i.version} predates the subagent cache controls (2.1.242); the settings below would be ignored.`] }
  if (supported === null) notes.push('The Claude Code version is unknown, so support for these controls is unverified.')
  const force = truthy(i.forceFiveMinute)
  if (force === null) notes.push('FORCE_PROMPT_CACHING_5M has a value this reader does not recognise; treated as not set.')
  const enable = truthy(i.enableOneHour)
  if (enable === null) notes.push('ENABLE_PROMPT_CACHING_1H has a value this reader does not recognise; treated as not set.')
  const env = i.envTtl === undefined || i.envTtl === '' ? null : ttlOf(i.envTtl)
  if (i.envTtl !== undefined && i.envTtl !== '' && env === null) notes.push('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL is set to a value other than "5m" or "1h"; the host does not take it. Use "1h", not a number of minutes.')
  const setting = ttlOf(i.settingTtl)
  if (i.settingTtl !== undefined && setting === null) notes.push('subagentPromptCacheTtl is set to something other than "5m" or "1h" (a number such as 60 is not valid); the host ignores it. Use "1h".')
  if (force === true) {
    if (env === '1h' || setting === '1h') notes.push('FORCE_PROMPT_CACHING_5M is set and wins over the 1h you configured.')

    return { supported, ttl: '5m', source: 'force_5m_env', notes }
  }
  if (env !== null) {
    if (setting !== null && setting !== env) notes.push(`The environment variable (${env}) takes precedence over the setting (${setting}).`)

    return { supported, ttl: env, source: 'env', notes }
  }
  if (setting !== null) return { supported, ttl: setting, source: 'setting', notes }
  if (enable === true) return { supported, ttl: '1h', source: 'enable_1h_env', notes }

  return { supported, ttl: 'auto', source: 'default', notes }
}

/** One owner-facing line on where the answer came from. */
export const sourceText = (c: CacheReading): string => ({
  force_5m_env: 'FORCE_PROMPT_CACHING_5M',
  env: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
  setting: 'settings: subagentPromptCacheTtl',
  enable_1h_env: 'ENABLE_PROMPT_CACHING_1H',
  default: 'nothing set (host default)',
  unsupported: 'host too old',
})[c.source]

export const RESTART_TEXT = 'Environment variables are read when Claude Code starts, so a change needs a new session. A settings.json change is read by the host; Cockpit has not verified that a running session picks it up, so use a new session to be sure.'

export type Agents = { observed: number; longRunning: number }
/** Counts agents that ended, from their observed lifetimes; an unknown lifetime counts as observed and not long. */
export const agentsOf = (lifetimes: readonly (number | null)[]): Agents => ({ observed: lifetimes.length, longRunning: lifetimes.filter(ms => ms !== null && ms >= LONG_RUNNING_MS).length })

/** The recommendation, or null when there is nothing honest to say. Never changes anything; never claims a saving. */
export const recommendation = (c: CacheReading, a: Agents): string | null => {
  if (c.source === 'unsupported') return null
  if (c.source === 'force_5m_env') return 'FORCE_PROMPT_CACHING_5M is set and overrides every other cache setting, so 1-hour caching cannot take effect until it is unset.'
  if (c.ttl === '1h') return '1-hour subagent caching is configured. Whether the host honoured it for a request is not reported to plugins, and 1-hour writes cost more than 5-minute ones.'
  if (a.observed === 0) return 'No subagents have ended in this session yet, so there is nothing to base a cache recommendation on.'
  if (a.longRunning > 0) {
    return `Long-running subagents detected (${a.longRunning} of ${a.observed} ran 5 minutes or more). Consider 1-hour prompt caching: add "subagentPromptCacheTtl": "1h" to your own settings.json, or set CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h. One-hour cache writes are billed higher and this does not show that it lowers cost or usage; Cockpit changes nothing. ${RESTART_TEXT}`
  }

  return `All ${a.observed} subagents seen this session ended in under 5 minutes, so the default 5-minute cache is likely enough. No change suggested.`
}
