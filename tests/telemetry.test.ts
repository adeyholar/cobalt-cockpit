// Telemetry: what is kept, what is never kept, and what /cockpit stats may say.

import { describe, expect, test } from 'claude-code/testing'
import { MONTH_CAP_BYTES, aggregate, appendBounded, cleanEvent, encode, expiredFiles, latencyOf, parseLines, parseWindow, statsCsv, statsJson, statsText } from '../hooks/telemetry'
import type { TEvent } from '../hooks/telemetry'
import { resetStore } from '../hooks/telemetry-store'
import { command, planAndComplete, prompt, start, world } from './world'

// built at run time: the fixtures are synthetic and nothing here is a real path or key
const HOMEDIR = ['', 'home', 'someone'].join('/')
const KEY = ['sk', 'ant', 'api03', 'S'.repeat(30)].join('-')
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 10)
const req = (t: number, tier: 'HAIKU' | 'SONNET' | 'OPUS' | 'OTHER', extra: Record<string, unknown> = {}): TEvent => cleanEvent({ v: 1, t, k: 'req', tier, sub: false, ...extra })!
const all = { label: 'all', days: null }

describe('events are rebuilt from a whitelist', () => {
  test('unknown fields, free text and paths never survive', () => {
    const e = cleanEvent({ v: 1, t: 5, k: 'req', tier: 'SONNET', sub: true, prompt: 'rm -rf / password=hunter2', path: `${HOMEDIR}/secret`, inTok: 10, outTok: 4 })
    expect(e).toEqual({ v: 1, t: 5, k: 'req', tier: 'SONNET', sub: true, inTok: 10, outTok: 4 })
    expect(encode(e!)).not.toMatch(/hunter2|\/home/)
  })
  test('tokens are kept only when both figures were reported', () => {
    expect(cleanEvent({ v: 1, t: 1, k: 'req', tier: 'HAIKU', sub: false, inTok: 10 })).not.toHaveProperty('inTok')
    expect(cleanEvent({ v: 1, t: 1, k: 'req', tier: 'HAIKU', sub: false, inTok: 'ten', outTok: 4 })).not.toHaveProperty('outTok')
    expect(cleanEvent({ v: 1, t: 1, k: 'req', tier: 'HAIKU', sub: false, inTok: -1, outTok: 4 })).not.toHaveProperty('inTok')
  })
  test('a role or provider that is not a plain word is dropped, never stored', () => {
    expect(cleanEvent({ v: 1, t: 1, k: 'agent', tier: 'HAIKU', role: '/etc/passwd', ok: true, ms: 3 })).toBeNull()
    expect(cleanEvent({ v: 1, t: 1, k: 'route', mode: 'JEV', path: 'router', provider: 'a b; rm', calls: 1, answered: 1, outcome: 'accepted', ms: 3 })).toMatchObject({ provider: null })
  })
  test('the wrong schema, kind, tier or time is refused', () => {
    for (const bad of [null, 'x', 7, [], {}, { v: 2, t: 1, k: 'task', opus: true }, { v: 1, t: 'now', k: 'task', opus: true }, { v: 1, t: 1, k: 'task', opus: 'yes' }, { v: 1, t: 1, k: 'req', tier: 'FABLE', sub: false }, { v: 1, t: Infinity, k: 'task', opus: true }, { v: 1, t: 1, k: 'zzz' }]) expect(cleanEvent(bad)).toBeNull()
  })
})

describe('reading is tolerant', () => {
  test('damaged, foreign and blank lines are counted and skipped', () => {
    const text = [encode(req(1, 'OPUS')), '', '{not json', '{"v":1,"t":1,"k":"nope"}', 'null', encode(req(2, 'HAIKU')), '\u0000\u0000'].join('\n')
    const { events, corrupt } = parseLines(text)
    expect(events.map(e => e.t)).toEqual([1, 2])
    expect(corrupt).toBe(4)
  })
  test('empty and garbage files yield nothing and no error', () => {
    expect(parseLines('')).toEqual({ events: [], corrupt: 0 })
    expect(parseLines('\n\n').events).toEqual([])
  })
})

describe('storage is bounded', () => {
  test('a month over its cap drops the oldest lines and says how many', () => {
    let text = ''
    for (let i = 0; i < 400; i++) text = appendBounded(text, req(i, 'SONNET'), i, 2000)
    expect(text.length).toBeLessThanOrEqual(2000)
    const { events } = parseLines(text)
    expect(events[0]!.k).toBe('trim')
    expect(events.at(-1)).toMatchObject({ k: 'req', t: 399 })
    const trimmed = events.filter(e => e.k === 'trim')
    expect(trimmed).toHaveLength(1)
    // nothing is lost without being counted
    expect((trimmed[0] as { n: number }).n + events.filter(e => e.k === 'req').length).toBe(400)
  })
  test('the real cap is within what the host reads in one piece', () => {
    expect(MONTH_CAP_BYTES).toBeLessThan(4 * 1024 * 1024)
  })
  test('only exact month files older than 13 months are expired', () => {
    const names = ['2026-10.jsonl', '2025-10.jsonl', '2025-09.jsonl', '2024-01.jsonl', '2024-01.jsonl.bak', '../2024-01.jsonl', 'notes.txt', '2024-13.jsonl']
    expect(expiredFiles(names, NOW)).toEqual(['2025-09.jsonl', '2024-01.jsonl'])
  })
})

describe('statistics', () => {
  test('empty data says so and shows no percentage', () => {
    const s = aggregate([], 0, NOW, all)
    expect(statsText(s)).toContain('No telemetry recorded yet')
    expect(statsCsv(s)).toContain('requests,count,HAIKU,0,0')
    expect(JSON.parse(statsJson(s)).requests.total).toBe(0)
  })
  test('shares have the observed requests as their denominator, and unreported tokens are UNKNOWN, not zero', () => {
    const s = aggregate([req(NOW - 1, 'SONNET', { inTok: 100, outTok: 50 }), req(NOW - 2, 'SONNET'), req(NOW - 3, 'HAIKU'), req(NOW - 4, 'OPUS')], 0, NOW, all)
    const text = statsText(s)
    expect(text).toContain('SONNET 2/4 (50%)')
    expect(text).toContain('HAIKU  1/4 (25%)')
    expect(text).toContain('host reported them for 1/4 (25%) of requests')
    expect(text).toContain('input 100 · output 50')
    expect(text).toContain('cost UNKNOWN')
    expect(text).not.toMatch(/\$|saved|savings:/i)
  })
  test('no tokens reported at all reads UNKNOWN', () => {
    expect(statsText(aggregate([req(NOW - 1, 'HAIKU')], 0, NOW, all))).toContain('tokens: UNKNOWN')
  })
  test('windows cut by time', () => {
    const events = [req(NOW - 3 * DAY, 'HAIKU'), req(NOW - 20 * DAY, 'SONNET'), req(NOW - 200 * DAY, 'OPUS')]
    expect(aggregate(events, 0, NOW, parseWindow('7d')!).requests.total).toBe(1)
    expect(aggregate(events, 0, NOW, parseWindow('30d')!).requests.total).toBe(2)
    expect(aggregate(events, 0, NOW, parseWindow('all')!).requests.total).toBe(3)
    expect(parseWindow('90d')).toBeNull()
    expect(parseWindow('')).toBeNull()
  })
  test('routing, a local router receipt and a selected model are kept apart', () => {
    const e = (x: Record<string, unknown>) => cleanEvent({ v: 1, t: NOW - 1, ...x })!
    const s = aggregate([
      e({ k: 'route', mode: 'OFF', path: 'off', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }),
      e({ k: 'route', mode: 'JEV', path: 'router', calls: 2, answered: 2, outcome: 'accepted', provider: 'jev', ms: 900 }),
      e({ k: 'route', mode: 'NOBODYWHO', path: 'rules', calls: 0, answered: 0, outcome: 'none', provider: null, ms: null }),
      e({ k: 'nwho', op: 'decision', tier: '9b', ms: 300 }),
    ], 0, NOW, all)
    expect(s.routing.byMode).toEqual({ OFF: 1, JEV: 1, NOBODYWHO: 1 })
    expect(s.routing.byPath).toEqual({ off: 1, router: 1, rules: 1 })
    expect(s.nobodywho.total).toBe(1)
    // a routing decision adds no model request
    expect(s.requests.total).toBe(0)
    expect(statsText(s)).toContain('not which model did the work')
  })
  test('consultations by ground and outcome, and tasks with and without Opus', () => {
    const e = (x: Record<string, unknown>) => cleanEvent({ v: 1, t: NOW - 1, ...x })!
    const s = aggregate([
      e({ k: 'consult', ground: 'release', ev: 'refused' }), e({ k: 'consult', ground: 'release', ev: 'admitted', mandatory: true }),
      e({ k: 'consult', ground: 'release', ev: 'returned', ms: 5000 }), e({ k: 'consult', ground: 'release', ev: 'verified', state: 'pass', rel: 'no-go' }),
      e({ k: 'consult', ground: 'security', ev: 'admitted' }),
      e({ k: 'task', opus: true }), e({ k: 'task', opus: false }), e({ k: 'task', opus: false }),
    ], 0, NOW, all)
    expect(s.consultations.byGround['release']).toMatchObject({ refused: 1, admitted: 1, returned: 1, passed: 1, failed: 0 })
    expect(s.consultations.release).toEqual({ go: 0, noGo: 1 })
    expect(s.consultations.attempts).toBe(3)
    expect(s.tasks).toEqual({ completed: 3, withOpus: 1, withoutOpus: 2 })
    expect(statsText(s)).toContain('without 2/3 (67%)')
  })
  test('a trimmed month is reported as incomplete coverage', () => {
    const s = aggregate([cleanEvent({ v: 1, t: NOW - 1, k: 'trim', n: 12 })!, req(NOW - 1, 'HAIKU')], 0, NOW, all)
    expect(statsText(s)).toContain('12 older events dropped')
  })
  test('latency is from measured values only', () => {
    expect(latencyOf([])).toEqual({ n: 0, medianMs: null, p90Ms: null })
    expect(latencyOf([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({ n: 10, medianMs: 50, p90Ms: 90 })
  })
  test('csv quotes and has one header', () => {
    const csv = statsCsv(aggregate([req(NOW - 1, 'HAIKU')], 0, NOW, all))
    expect(csv.split('\n')[0]).toBe('section,metric,key,value,denominator')
    expect(csv).toContain('requests,count,HAIKU,1,1')
  })
})

describe('through the host', () => {
  const FILE = '/home/tester/.local/state/cobalt-cockpit/telemetry/'
  const files = (w: ReturnType<typeof world>) => Object.entries(w.files).filter(([p]) => p.startsWith(FILE))

  test('a finished task is recorded without its prompt, the files are restricted, and stats reads it back', async ($, on) => {
    resetStore()
    const w = world(on)
    await start($)
    await prompt($, `fix the login bug; the key is ${KEY} in ${HOMEDIR}/private/app.ts`)
    await planAndComplete($, 5)
    const written = files(w)
    expect(written).toHaveLength(1)
    const [path, text] = written[0]!
    expect(path).toMatch(/\/\d{4}-\d{2}\.jsonl$/)
    expect(text).not.toMatch(/api03|SECRET|login|\/home\/|fix the/)
    expect(text).toContain('"k":"route"')
    expect(w.telemetryRuns).toContainEqual(['mkdir', '-p', '-m', '700', '/home/tester/.local/state/cobalt-cockpit/telemetry'])
    expect(w.telemetryRuns).toContainEqual(['chmod', '600', path])
    const out = String((await command($, 'stats 30d')).text)
    expect(out).toContain('COBALT STATS / 30d')
    expect(out).toContain('ROUTING DECISIONS')
    expect(out).toContain('files restricted to you')
    expect(JSON.parse(String((await command($, 'stats all --json')).text)).schema).toBe(1)
    expect(String((await command($, 'stats all --csv')).text)).toStartWith('section,metric')
  })
  test('bad arguments are refused with usage and read nothing', async ($, on) => {
    resetStore(); world(on); await start($)
    for (const args of ['stats 90d', 'stats --json --csv', 'stats 7d --upload', 'stats ../../etc']) expect(String((await command($, args)).text)).toContain('usage /cockpit stats')
  })
  test('with no data the command says so; with a corrupt file it still answers', async ($, on) => {
    resetStore(); const w = world(on); await start($)
    expect(String((await command($, 'stats all')).text)).toContain('No telemetry recorded yet')
    w.files[`${FILE}2026-10.jsonl`] = '{broken\n\u0000\nnull\n'
    const out = String((await command($, 'stats all')).text)
    expect(out).toContain('No telemetry recorded yet')
    expect(out).toContain('3 unreadable lines skipped')
  })
  test('telemetry=false records nothing', { options: { telemetry: false } }, async ($, on) => {
    resetStore(); const w = world(on); await start($)
    await prompt($, 'x'); await planAndComplete($, 5)
    expect(files(w)).toHaveLength(0)
    expect(String((await command($, 'stats all')).text)).toContain('TELEMETRY / off')
  })
})
