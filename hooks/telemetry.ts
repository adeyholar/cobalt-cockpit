// Local model-intelligence telemetry.
//
// What it is: a small, bounded, local record of what the hooks really observed
// (a request a model answered, a subagent that ended, a router that was asked,
// an Opus consultation and how it went, a task that finished). It is written
// under $XDG_STATE_HOME/cobalt-cockpit/telemetry/ (default
// ~/.local/state/cobalt-cockpit/telemetry/), one file per month, one JSON object
// per line, schema version 1. Nothing is uploaded.
//
// What it is not: it keeps no prompt, code, diff, secret, architect answer,
// path, session id or free text. Every field below is an enum, a boolean or a
// number, and every event is rebuilt field by field from a whitelist, both when
// it is written and when it is read, so a foreign or damaged line can neither
// leak nor distort anything. A selection is not an invocation: a router
// decision says that a router was asked, never that a model did the work, and
// a subagent counts as invoked only when the host reported its request or its
// end. Tokens are summed only over requests whose host report carried both
// figures; nothing is estimated from text, and no dollar figure is ever made.
//
// The host gives a plugin `$.fs.write` (whole file) and no append, so a write
// reads the month's file, adds one line and writes it back. That is serialised
// in this process, capped per month (MONTH_CAP_BYTES, oldest lines dropped with
// a `trim` marker so the loss is visible) and kept for KEEP_MONTHS months.

export const SCHEMA = 1
export const MONTH_CAP_BYTES = 512 * 1024
export const KEEP_MONTHS = 13
export const DAY_MS = 86_400_000

export type Tier = 'HAIKU' | 'SONNET' | 'OPUS' | 'OTHER'
export const TIERS: readonly Tier[] = ['HAIKU', 'SONNET', 'OPUS', 'OTHER']
export type Ground = 'architecture' | 'security' | 'repeated-failure' | 'asked' | 'release'
const GROUND_SET: readonly string[] = ['architecture', 'security', 'repeated-failure', 'asked', 'release']
const ROLES: readonly string[] = ['scout', 'utility', 'explorer', 'researcher', 'reviewer', 'worker', 'architect']
const MODES = ['OFF', 'NOBODYWHO', 'JEV'] as const
const OUTCOMES = ['accepted', 'rejected', 'fallback', 'none'] as const
const CONSULT_EVENTS = ['refused', 'admitted', 'returned', 'verified'] as const

export type TEvent =
  | { v: 1; t: number; k: 'req'; tier: Tier; sub: boolean; inTok?: number; outTok?: number }
  | { v: 1; t: number; k: 'agent'; tier: Tier; role: string; ok: boolean | null; ms: number | null }
  | { v: 1; t: number; k: 'route'; mode: typeof MODES[number]; path: 'off' | 'rules' | 'router'; provider: string | null; calls: number; answered: number; outcome: typeof OUTCOMES[number]; ms: number | null }
  | { v: 1; t: number; k: 'nwho'; op: 'decision' | 'prune'; tier: string; ms: number | null }
  | { v: 1; t: number; k: 'consult'; ground: Ground; ev: typeof CONSULT_EVENTS[number]; mandatory?: boolean; state?: 'pass' | 'fail'; rel?: 'go' | 'no-go'; ms?: number }
  | { v: 1; t: number; k: 'task'; opus: boolean }
  | { v: 1; t: number; k: 'trim'; n: number }

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e15
const word = (x: unknown): string | null => (typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(x) ? x.toLowerCase() : null)
const oneOf = <T extends string>(x: unknown, set: readonly T[]): T | null => (typeof x === 'string' && (set as readonly string[]).includes(x) ? x as T : null)
const optNum = (x: unknown): number | null => (isNum(x) ? Math.round(x) : null)

/** The tier a model id names, or OTHER; never the id itself. */
export const modelTier = (model: unknown): Tier => {
  const id = typeof model === 'string' ? model.toLowerCase() : ''

  return id.includes('opus') ? 'OPUS' : id.includes('sonnet') ? 'SONNET' : id.includes('haiku') ? 'HAIKU' : 'OTHER'
}
/** The role of a subagent type (`cobalt-cockpit:scout`, `worker`) as one of the known words, else `other`. */
export const agentRole = (subagentType: unknown): string => {
  const name = typeof subagentType === 'string' ? (subagentType.split(':').pop() ?? '').toLowerCase() : ''

  return ROLES.includes(name) ? name : 'other'
}

/** Rebuilds an event from its whitelisted fields, or null when it is not one. Used on write and on read. */
export const cleanEvent = (raw: unknown): TEvent | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r['v'] !== SCHEMA || !isNum(r['t'])) return null
  const base = { v: 1 as const, t: Math.round(r['t'] as number) }
  switch (r['k']) {
    case 'req': {
      const tier = oneOf(r['tier'], TIERS)
      if (tier === null || typeof r['sub'] !== 'boolean') return null
      // tokens count only when the host reported both figures
      const both = isNum(r['inTok']) && isNum(r['outTok'])

      return { ...base, k: 'req', tier, sub: r['sub'], ...(both ? { inTok: Math.round(r['inTok'] as number), outTok: Math.round(r['outTok'] as number) } : {}) }
    }
    case 'agent': {
      const tier = oneOf(r['tier'], TIERS)
      const role = word(r['role'])
      if (tier === null || role === null) return null

      return { ...base, k: 'agent', tier, role, ok: typeof r['ok'] === 'boolean' ? r['ok'] : null, ms: optNum(r['ms']) }
    }
    case 'route': {
      const mode = oneOf(r['mode'], MODES)
      const path = oneOf(r['path'], ['off', 'rules', 'router'] as const)
      const outcome = oneOf(r['outcome'], OUTCOMES)
      if (mode === null || path === null || outcome === null || !isNum(r['calls']) || !isNum(r['answered'])) return null

      return { ...base, k: 'route', mode, path, provider: word(r['provider']), calls: Math.round(r['calls'] as number), answered: Math.round(r['answered'] as number), outcome, ms: optNum(r['ms']) }
    }
    case 'nwho': {
      const op = oneOf(r['op'], ['decision', 'prune'] as const)
      const tier = word(r['tier'])
      if (op === null || tier === null) return null

      return { ...base, k: 'nwho', op, tier, ms: optNum(r['ms']) }
    }
    case 'consult': {
      const ground = oneOf(r['ground'], GROUND_SET as readonly Ground[])
      const ev = oneOf(r['ev'], CONSULT_EVENTS)
      if (ground === null || ev === null) return null
      const state = oneOf(r['state'], ['pass', 'fail'] as const)
      const rel = oneOf(r['rel'], ['go', 'no-go'] as const)
      const ms = optNum(r['ms'])

      return { ...base, k: 'consult', ground, ev, ...(typeof r['mandatory'] === 'boolean' ? { mandatory: r['mandatory'] } : {}), ...(state === null ? {} : { state }), ...(rel === null ? {} : { rel }), ...(ms === null ? {} : { ms }) }
    }
    case 'task':
      return typeof r['opus'] === 'boolean' ? { ...base, k: 'task', opus: r['opus'] } : null
    case 'trim':
      return isNum(r['n']) ? { ...base, k: 'trim', n: Math.round(r['n'] as number) } : null
    default:
      return null
  }
}

export const encode = (e: TEvent): string => JSON.stringify(e)

/** Tolerant reader: damaged, foreign or blank lines are counted, never thrown. */
export const parseLines = (text: string): { events: TEvent[]; corrupt: number } => {
  const events: TEvent[] = []
  let corrupt = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { corrupt++; continue }
    const e = cleanEvent(parsed)
    if (e === null) corrupt++
    else events.push(e)
  }

  return { events, corrupt }
}

/** Adds one line to a month's text and keeps it within `cap` bytes by dropping the oldest lines, leaving one visible `trim` marker with the running count. */
export const appendBounded = (text: string, e: TEvent, at: number, cap = MONTH_CAP_BYTES): string => {
  const lines = [...text.split('\n').filter(l => l !== ''), encode(e)]
  const size = (ls: readonly string[]) => ls.reduce((n, l) => n + l.length + 1, 0)
  if (size(lines) <= cap) return `${lines.join('\n')}\n`
  // the newest line always stays; trim to three quarters so a write does not trim every time
  let dropped = 0
  while (lines.length > 1 && size(lines) > cap * 0.75) { const gone = lines.shift()!; const m = cleanEvent(safe(gone)); dropped += m?.k === 'trim' ? m.n : 1 }
  const kept: string[] = []
  for (const l of lines) { const m = cleanEvent(safe(l)); if (m?.k === 'trim') dropped += m.n; else kept.push(l) }

  return `${[encode({ v: 1, t: Math.round(at), k: 'trim', n: dropped }), ...kept].join('\n')}\n`
}
const safe = (line: string): unknown => { try { return JSON.parse(line) } catch { return null } }

export const monthKey = (at: number): string => new Date(at).toISOString().slice(0, 7)
export const monthFile = (key: string): string => `${key}.jsonl`
export const isMonthFile = (name: string): boolean => /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(name)
/** Month files older than the retention window, by name. */
export const expiredFiles = (names: readonly string[], now: number): string[] => {
  const d = new Date(now)
  const cutoff = d.getUTCFullYear() * 12 + d.getUTCMonth() - (KEEP_MONTHS - 1)

  return names.filter(n => isMonthFile(n) && Number(n.slice(0, 4)) * 12 + Number(n.slice(5, 7)) - 1 < cutoff)
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type Latency = { n: number; medianMs: number | null; p90Ms: number | null }
export type Stats = {
  schema: 1
  window: string
  since: number | null
  until: number
  events: number
  corruptLines: number
  trimmedEvents: number
  firstEvent: number | null
  requests: { total: number; main: number; subagent: number; byTier: Record<Tier, number>; tokens: { reported: number; unreported: number; input: number; output: number }; cost: 'UNKNOWN' }
  agents: { total: number; byTier: Record<Tier, { count: number; succeeded: number; failed: number; unknownStatus: number; latency: Latency }> }
  routing: { total: number; byMode: Record<string, number>; byPath: Record<string, number>; byProvider: Record<string, number>; byOutcome: Record<string, number>; latency: Latency }
  nobodywho: { total: number; byOp: Record<string, number>; byTier: Record<string, number>; latency: Latency }
  consultations: { byGround: Record<string, { refused: number; admitted: number; returned: number; passed: number; failed: number; latency: Latency }>; release: { go: number; noGo: number }; attempts: number; admitted: number; returned: number }
  tasks: { completed: number; withOpus: number; withoutOpus: number }
}

const blank = (): Latency => ({ n: 0, medianMs: null, p90Ms: null })
export const latencyOf = (values: readonly number[]): Latency => {
  if (values.length === 0) return blank()
  const s = [...values].sort((a, b) => a - b)
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!

  return { n: s.length, medianMs: at(0.5), p90Ms: at(0.9) }
}
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1 }

export const parseWindow = (word: string): { label: string; days: number | null } | null =>
  word === '7d' ? { label: '7d', days: 7 } : word === '30d' ? { label: '30d', days: 30 } : word === 'all' ? { label: 'all', days: null } : null

export const aggregate = (events: readonly TEvent[], corruptLines: number, now: number, win: { label: string; days: number | null }): Stats => {
  const since = win.days === null ? null : now - win.days * DAY_MS
  const inside = events.filter(e => e.k !== 'trim' && (since === null || e.t >= since) && e.t <= now + DAY_MS)
  const zero = (): Record<Tier, number> => ({ HAIKU: 0, SONNET: 0, OPUS: 0, OTHER: 0 })
  const requests = { total: 0, main: 0, subagent: 0, byTier: zero(), tokens: { reported: 0, unreported: 0, input: 0, output: 0 }, cost: 'UNKNOWN' as const }
  const agentLat: Record<Tier, number[]> = { HAIKU: [], SONNET: [], OPUS: [], OTHER: [] }
  const agents: Stats['agents'] = { total: 0, byTier: Object.fromEntries(TIERS.map(t => [t, { count: 0, succeeded: 0, failed: 0, unknownStatus: 0, latency: blank() }])) as Stats['agents']['byTier'] }
  const routing: Stats['routing'] = { total: 0, byMode: {}, byPath: {}, byProvider: {}, byOutcome: {}, latency: blank() }
  const routeLat: number[] = []
  const nwho: Stats['nobodywho'] = { total: 0, byOp: {}, byTier: {}, latency: blank() }
  const nwhoLat: number[] = []
  const consultations: Stats['consultations'] = { byGround: {}, release: { go: 0, noGo: 0 }, attempts: 0, admitted: 0, returned: 0 }
  const consultLat: Record<string, number[]> = {}
  const tasks = { completed: 0, withOpus: 0, withoutOpus: 0 }
  for (const e of inside) {
    if (e.k === 'req') {
      requests.total++; requests.byTier[e.tier]++
      if (e.sub) requests.subagent++; else requests.main++
      if (e.inTok !== undefined && e.outTok !== undefined) { requests.tokens.reported++; requests.tokens.input += e.inTok; requests.tokens.output += e.outTok } else requests.tokens.unreported++
    } else if (e.k === 'agent') {
      agents.total++
      const a = agents.byTier[e.tier]
      a.count++
      if (e.ok === true) a.succeeded++; else if (e.ok === false) a.failed++; else a.unknownStatus++
      if (e.ms !== null) agentLat[e.tier].push(e.ms)
    } else if (e.k === 'route') {
      routing.total++; bump(routing.byMode, e.mode); bump(routing.byPath, e.path); bump(routing.byOutcome, e.outcome)
      if (e.provider !== null) bump(routing.byProvider, e.provider)
      if (e.ms !== null) routeLat.push(e.ms)
    } else if (e.k === 'nwho') {
      nwho.total++; bump(nwho.byOp, e.op); bump(nwho.byTier, e.tier)
      if (e.ms !== null) nwhoLat.push(e.ms)
    } else if (e.k === 'consult') {
      const g = consultations.byGround[e.ground] ??= { refused: 0, admitted: 0, returned: 0, passed: 0, failed: 0, latency: blank() }
      if (e.ev === 'refused') g.refused++
      else if (e.ev === 'admitted') g.admitted++
      else if (e.ev === 'returned') { g.returned++; if (e.ms !== undefined) (consultLat[e.ground] ??= []).push(e.ms) }
      else if (e.state === 'pass') g.passed++
      else if (e.state === 'fail') g.failed++
      if (e.ev === 'verified' && e.ground === 'release' && e.rel !== undefined) { if (e.rel === 'go') consultations.release.go++; else consultations.release.noGo++ }
    } else if (e.k === 'task') {
      tasks.completed++; if (e.opus) tasks.withOpus++; else tasks.withoutOpus++
    }
  }
  for (const t of TIERS) agents.byTier[t].latency = latencyOf(agentLat[t])
  routing.latency = latencyOf(routeLat); nwho.latency = latencyOf(nwhoLat)
  for (const [ground, g] of Object.entries(consultations.byGround)) {
    g.latency = latencyOf(consultLat[ground] ?? [])
    consultations.attempts += g.refused + g.admitted; consultations.admitted += g.admitted; consultations.returned += g.returned
  }
  const trimmed = events.filter((e): e is Extract<TEvent, { k: 'trim' }> => e.k === 'trim' && (since === null || e.t >= since)).reduce((n, e) => n + e.n, 0)

  return {
    schema: 1, window: win.label, since, until: now, events: inside.length, corruptLines, trimmedEvents: trimmed,
    firstEvent: events.length === 0 ? null : Math.min(...events.map(e => e.t)),
    requests, agents, routing, nobodywho: nwho, consultations, tasks,
  }
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${n}/${d} (${Math.round((n / d) * 100)}%)`)
const ms = (n: number | null): string => (n === null ? 'UNKNOWN' : n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`)
const lat = (l: Latency): string => (l.n === 0 ? 'latency UNKNOWN' : `latency median ${ms(l.medianMs)} · p90 ${ms(l.p90Ms)} (n=${l.n})`)
const day = (t: number): string => new Date(t).toISOString().slice(0, 10)
const entries = (m: Record<string, number>): string => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'

export const statsText = (s: Stats): string => {
  const out: string[] = []
  const span = s.since === null ? 'all recorded time' : `${day(s.since)} → ${day(s.until)}`
  out.push(`COBALT STATS / ${s.window} · ${span}`)
  if (s.firstEvent === null && s.events === 0) {
    out.push('No telemetry recorded yet. Records begin when this build first observes a request, a subagent, a router or a consultation.')
    if (s.corruptLines > 0) out.push(`${s.corruptLines} unreadable line${s.corruptLines === 1 ? '' : 's'} skipped.`)

    return out.join('\n')
  }
  out.push(`${s.events} events in the window · recording began ${s.firstEvent === null ? 'UNKNOWN' : day(s.firstEvent)} · ${s.corruptLines} unreadable line${s.corruptLines === 1 ? '' : 's'} skipped${s.trimmedEvents > 0 ? ` · ${s.trimmedEvents} older events dropped by the size bound (incomplete coverage)` : ''}`)
  const r = s.requests
  out.push('', `MODEL REQUESTS / observed by the host's request hook · ${r.total} total (${r.main} main loop, ${r.subagent} subagent)`)
  if (r.total === 0) out.push('  none observed')
  else for (const t of TIERS) if (r.byTier[t] > 0) out.push(`  ${t.padEnd(6)} ${pct(r.byTier[t], r.total)} of observed requests`)
  out.push(`  tokens: ${r.tokens.reported === 0 ? 'UNKNOWN' : `input ${r.tokens.input} · output ${r.tokens.output}`} · host reported them for ${pct(r.tokens.reported, r.total)} of requests · cost UNKNOWN (the host reports none per request; nothing is estimated)`)
  out.push('', `SUBAGENTS / observed ending · ${s.agents.total} total`)
  if (s.agents.total === 0) out.push('  none observed')
  else for (const t of TIERS) {
    const a = s.agents.byTier[t]
    if (a.count > 0) out.push(`  ${t.padEnd(6)} ${a.count} (${pct(a.count, s.agents.total)} of subagents) · ok ${a.succeeded} · failed ${a.failed} · status unknown ${a.unknownStatus} · ${lat(a.latency)}`)
  }
  const g = s.routing
  out.push('', `ROUTING DECISIONS / which router was asked at the start of a task, not which model did the work · ${g.total} total`)
  if (g.total === 0) out.push('  none observed')
  else out.push(`  by mode ${entries(g.byMode)}`, `  by path ${entries(g.byPath)} (off: no router selected · rules: settled by rule · router: a router was asked)`, `  by provider ${entries(g.byProvider)}`, `  outcome ${entries(g.byOutcome)} · ${lat(g.latency)}`)
  const n = s.nobodywho
  out.push('', `LOCAL ROUTER RECEIPTS / NobodyWho decisions and prunes the router wrote · ${n.total} total`)
  if (n.total === 0) out.push('  none observed (read from the shared router ledger; absent when Local Control is off)')
  else out.push(`  by operation ${entries(n.byOp)} · by tier ${entries(n.byTier)} · ${lat(n.latency)}`)
  const c = s.consultations
  out.push('', `OPUS CONSULTATIONS / attempts ${c.attempts} · admitted ${c.admitted} (${pct(c.admitted, c.attempts)} of attempts) · returned ${pct(c.returned, c.admitted)} of admitted`)
  const grounds = Object.entries(c.byGround)
  if (grounds.length === 0) out.push('  none observed')
  for (const [name, x] of grounds) out.push(`  ${name.padEnd(16)} refused ${x.refused} · admitted ${x.admitted} · returned ${x.returned} · verified pass ${x.passed} · fail ${x.failed} · ${lat(x.latency)}`)
  if (c.release.go + c.release.noGo > 0) out.push(`  release recommendations: GO ${c.release.go} · NO-GO ${c.release.noGo}`)
  const t = s.tasks
  out.push('', `TASKS COMPLETED / ${t.completed}`)
  if (t.completed > 0) out.push(`  with an Opus consultation ${pct(t.withOpus, t.completed)} · without ${pct(t.withoutOpus, t.completed)}`)
  out.push('', 'Coverage: only what the plugin hooks saw while Cockpit was running. Subagent tokens, cost, and any call made outside a hook are UNKNOWN, not zero. No savings figure is computed.')

  return out.join('\n')
}

const csvCell = (v: string | number | null): string => { const t = v === null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }

/** A flat table: section, metric, key, value, denominator ('' when none). */
export const statsCsv = (s: Stats): string => {
  const rows: (string | number | null)[][] = [['section', 'metric', 'key', 'value', 'denominator']]
  const add = (section: string, metric: string, key: string, value: number | null, denominator: number | null = null) => rows.push([section, metric, key, value, denominator])
  add('window', 'events', s.window, s.events); add('window', 'corrupt_lines', s.window, s.corruptLines); add('window', 'trimmed_events', s.window, s.trimmedEvents)
  for (const t of TIERS) add('requests', 'count', t, s.requests.byTier[t], s.requests.total)
  add('requests', 'tokens_reported_requests', 'all', s.requests.tokens.reported, s.requests.total)
  add('requests', 'input_tokens', 'reported_only', s.requests.tokens.reported === 0 ? null : s.requests.tokens.input)
  add('requests', 'output_tokens', 'reported_only', s.requests.tokens.reported === 0 ? null : s.requests.tokens.output)
  for (const t of TIERS) { const a = s.agents.byTier[t]; add('agents', 'count', t, a.count, s.agents.total); add('agents', 'median_ms', t, a.latency.medianMs, a.latency.n); add('agents', 'p90_ms', t, a.latency.p90Ms, a.latency.n) }
  for (const [k, v] of Object.entries(s.routing.byMode)) add('routing', 'mode', k, v, s.routing.total)
  for (const [k, v] of Object.entries(s.routing.byPath)) add('routing', 'path', k, v, s.routing.total)
  for (const [k, v] of Object.entries(s.routing.byProvider)) add('routing', 'provider', k, v, s.routing.total)
  for (const [k, v] of Object.entries(s.nobodywho.byOp)) add('nobodywho', 'operation', k, v, s.nobodywho.total)
  for (const [ground, x] of Object.entries(s.consultations.byGround)) for (const [metric, v] of Object.entries({ refused: x.refused, admitted: x.admitted, returned: x.returned, verified_pass: x.passed, verified_fail: x.failed })) add('consultations', metric, ground, v)
  add('tasks', 'completed', 'all', s.tasks.completed); add('tasks', 'with_opus', 'all', s.tasks.withOpus, s.tasks.completed); add('tasks', 'without_opus', 'all', s.tasks.withoutOpus, s.tasks.completed)

  return `${rows.map(r => r.map(csvCell).join(',')).join('\n')}\n`
}

export const statsJson = (s: Stats): string => JSON.stringify(s, null, 2)
