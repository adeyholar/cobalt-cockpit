import { describe, expect, test } from 'claude-code/testing'
import { agentsText, swarmHint } from '../hooks/inspector'
import { swarmGraph } from '../hooks/field'
import { orchestraRows } from '../hooks/orchestra'
import { admitTask, bindAgent, emptySwarm, escalateTask, finishTask, heartbeat, markStalled, requestCancel, resolveEscalation, submitTask, summarizeSwarm } from '../hooks/swarm'
import type { Ledger, Swarm } from '../types'
import { hostState, rowsOf, start, world } from './world'

// The HUD's one line about the swarm: only when a task is blocked, quiet or escalated, from recorded state alone.

const add = (s: Swarm, id: string, extra: Record<string, unknown> = {}, at = 1000): Swarm => submitTask(s, { id, tier: 'SONNET', role: 'worker', objective: `Bounded ${id}`, owned: [`/work/${id}.ts`], mode: 'write', ...extra }, at).swarm
const run = (s: Swarm, id: string, at = 2000): Swarm => bindAgent(admitTask(s, id, at).swarm, id, `agent-${id}`, at)
const WIDE = 120

/** Two blocked, one quiet, one escalated, one queued, one running, one completed, one failed; `now` is when it was last looked at. */
const busy = (now = 400_000): Swarm => {
  let s = emptySwarm({ total: 8, sonnet: 8, haiku: 4, stallMs: 300_000 })
  for (const id of ['run', 'quiet', 'esc', 'done', 'fail']) s = run(add(s, id), id)
  s = add(s, 'b1', { dependencies: ['run'] }); s = add(s, 'b2', { owned: ['/work/run.ts'] }); s = add(s, 'queued')
  s = admitTask(s, 'b1', 2500).swarm                         // refused: its dependency is running
  s = admitTask(s, 'b2', 2500).swarm                         // refused: an ownership conflict
  s = finishTask(s, 'done', 'completed', { conclusion: 'ok' }, 3000)
  s = finishTask(s, 'fail', 'failed', { conclusion: 'broke' }, 3000)
  s = escalateTask(s, 'esc', { objective: 'x', discoveries: [], evidence: [], question: 'which way?', risk: 'r', nextAction: 'n', locations: [], to: 'OPUS' }, 3100)
  s = finishTask(s, 'esc', 'completed', null, 3200)          // the host stopped it: escalated and unresolved
  s = heartbeat(heartbeat(s, 'run', now), 'b1', now)
  s = markStalled(s, now)                                    // `quiet` has shown nothing for longer than the threshold

  return s
}

describe('when the swarm needs nobody, the HUD says nothing', () => {
  test('no tasks, or only queued, reserved, running, completed, failed and cancelled ones', () => {
    expect(swarmHint(emptySwarm(), WIDE)).toBeNull()
    let s = emptySwarm()
    s = add(s, 'q')
    expect(swarmHint(s, WIDE)).toBeNull()                    // queued: assigned, not yet tried
    s = admitTask(add(s, 'r'), 'r', 10).swarm
    expect(swarmHint(s, WIDE)).toBeNull()                    // reserved: awaiting the host's agent
    s = run(add(s, 'a'), 'a')
    s = finishTask(run(add(s, 'c'), 'c'), 'c', 'completed', { conclusion: 'ok' }, 20)
    s = finishTask(run(add(s, 'f'), 'f'), 'f', 'failed', { conclusion: 'no' }, 20)
    s = requestCancel(add(s, 'x'), 'x', 30)
    s = requestCancel(s, 'a', 40)                            // cancelling: ownership held until the host confirms
    expect(s.tasks.map(t => t.state).sort()).toEqual(['cancelled', 'completed', 'failed', 'queued', 'reserved', 'running'])
    expect(swarmHint(s, WIDE)).toBeNull()
  })
  test('silence shorter than the stall threshold is not a state: nothing is inferred from the clock', () => {
    let s = run(add(emptySwarm({ stallMs: 300_000 }), 'a'), 'a', 1000)
    // nothing marked it, however old its last activity is: the hint has no clock of its own
    expect(s.tasks[0]!.lastActivityAt).toBe(1000)
    expect(swarmHint(s, WIDE)).toBeNull()
    s = markStalled(s, 1000 + 299_999)
    expect(swarmHint(s, WIDE)).toBeNull()
    s = markStalled(s, 1000 + 300_000)
    expect(swarmHint(s, WIDE)).toBe('SWARM: 1 QUIET 5m+ · /cockpit agents')
    // one observed tool call and it is running again
    expect(swarmHint(heartbeat(s, 'a', 1000 + 300_500), WIDE)).toBeNull()
  })
})

describe('blocked, quiet and escalated are told apart, and queued is not counted', () => {
  const s = busy()
  test('the full line', () => {
    expect(s.tasks.map(t => `${t.id}:${t.state}`)).toEqual(['run:running', 'quiet:stalled', 'esc:escalated', 'done:completed', 'fail:failed', 'b1:blocked', 'b2:blocked', 'queued:queued'])
    expect(swarmHint(s, WIDE)).toBe('SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents')
  })
  test('each state alone', () => {
    const only = (keep: string): Swarm => ({ ...s, tasks: s.tasks.filter(t => t.state === keep || t.state === 'running') })
    expect(swarmHint(only('blocked'), WIDE)).toBe('SWARM: 2 BLOCKED · /cockpit agents')
    expect(swarmHint(only('stalled'), WIDE)).toBe('SWARM: 1 QUIET 5m+ · /cockpit agents')
    expect(swarmHint(only('escalated'), WIDE)).toBe('SWARM: 1 ESCALATED · /cockpit agents')
    expect(swarmHint(only('queued'), WIDE)).toBeNull()
  })
  test('the quiet threshold is the configured one, in the unit that fits it', () => {
    const at = (stallMs: number): Swarm => ({ ...s, config: { ...s.config, stallMs } })
    expect(swarmHint(at(600_000), WIDE)).toContain('1 QUIET 10m+')
    // rounded down: quiet for ninety seconds is at least one minute, not two
    expect(swarmHint(at(90_000), WIDE)).toContain('1 QUIET 1m+')
    expect(swarmHint(at(119_999), WIDE)).toContain('1 QUIET 1m+')
    expect(swarmHint(at(120_000), WIDE)).toContain('1 QUIET 2m+')
    expect(swarmHint(at(30_000), WIDE)).toContain('1 QUIET 30s+')
    expect(swarmHint(at(1_999), WIDE)).toContain('1 QUIET 1s+')
  })
  test('it clears as each is settled: a resolved escalation, a cancelled blocked task, a recovered agent', () => {
    let next = resolveEscalation(s, 'esc', { conclusion: 'go left', evidence: ['read it'] }, 500_000)
    expect(swarmHint(next, WIDE)).toBe('SWARM: 2 BLOCKED · 1 QUIET 5m+ · /cockpit agents')
    next = requestCancel(requestCancel(next, 'b1', 500_001), 'b2', 500_001)
    expect(swarmHint(next, WIDE)).toBe('SWARM: 1 QUIET 5m+ · /cockpit agents')
    next = heartbeat(next, 'quiet', 500_002)
    expect(swarmHint(next, WIDE)).toBeNull()
  })
  test('the same figures the Inspector and the pane show', () => {
    const summary = summarizeSwarm(s)
    expect([summary.blocked, summary.stalled, summary.escalated, summary.queue]).toEqual([2, 1, 1, 1])
    const header = agentsText({ swarm: s, agents: [], now: 400_000, columns: WIDE }).split('\n')[0]
    expect(header).toContain('3 waiting · 1 stalled · 1 escalated')       // waiting is queued and blocked together, by name
    // the narrow header names each, and leaves a zero out so the done count and the wave stay in view
    expect(agentsText({ swarm: s, agents: [], now: 400_000, columns: 70 }).split('\n')[0]).toBe('AGENTS · 2 active · 3 waiting · 1 stalled · 1 esc · 1/8 done · RECONN…')
    expect(agentsText({ swarm: add(emptySwarm(), 'q'), agents: [], now: 0, columns: 70 }).split('\n')[0]).toBe('AGENTS · 0 active · 1 waiting · 0/1 done · RECONNAISSANCE')
    // the Activity Field's labels count them apart as well
    expect(swarmGraph(s)?.label).toContain('queue 1 · blocked 2 · quiet 1')
    expect(swarmGraph(s)?.branches[0]?.label).toContain('queue 1 · blocked 2 · quiet 1 · done 1 · failed 1')
    expect(swarmGraph(add(emptySwarm(), 'q'))?.label).toContain('queue 1 · blocked 0')
    expect(swarmGraph(add(emptySwarm(), 'q'))?.label).not.toContain('quiet')
    const rows = orchestraRows({ meter: { model: 'claude-opus-5-5' } as never, task: null, activity: { kind: 'IDLE' } as never, isWorking: false, agents: [], nwho: null, limit: 8, now: 400_000, swarm: s }, WIDE, { accent: 'a', ok: 'o', bad: 'b', steel: 's' })
    const graph = rows.map(row => row.map(seg => seg.text).join('')).find(text => text.includes('TASK GRAPH'))
    expect(graph).toContain('queue 1 · blocked 2 · quiet 1 · escalated 1')
    // and a swarm with nothing quiet or escalated reads as it always did
    const calm = orchestraRows({ meter: { model: 'claude-opus-5-5' } as never, task: null, activity: { kind: 'IDLE' } as never, isWorking: false, agents: [], nwho: null, limit: 8, now: 0, swarm: add(emptySwarm(), 'q') }, WIDE, { accent: 'a', ok: 'o', bad: 'b', steel: 's' })
    expect(calm.map(row => row.map(seg => seg.text).join('')).find(text => text.includes('TASK GRAPH'))).toContain('0/1 complete · parallel 0 · queue 1 · blocked 0')
  })
})

describe('narrow terminals', () => {
  const s = busy()
  test('the widest form that fits is used, and the states stay apart until only a total fits', () => {
    const forms: [number, string][] = [
      [62, 'SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents'],
      [61, 'SWARM: 2 BLOCKED · 1 QUIET · 1 ESCALATED · /cockpit agents'],
      [58, 'SWARM: 2 BLOCKED · 1 QUIET · 1 ESCALATED · /cockpit agents'],
      [57, 'SWARM: 2 BLK · 1 QUIET · 1 ESC · /cockpit agents'],
      [48, 'SWARM: 2 BLK · 1 QUIET · 1 ESC · /cockpit agents'],
      [47, 'SWARM: 4 ATTN · /cockpit agents'],
      [31, 'SWARM: 4 ATTN · /cockpit agents'],
      [30, 'SWARM: 4 ATTN'],
      [13, 'SWARM: 4 ATTN'],
      [12, 'SWARM: 4 AT…'],
      [6, 'SWARM…'],
    ]
    for (const [columns, want] of forms) expect([columns, swarmHint(s, columns)]).toEqual([columns, want])
  })
  test('the line never exceeds the width, at any width, for any mix of states', () => {
    const one = (keep: string[]): Swarm => ({ ...s, tasks: s.tasks.filter(t => keep.includes(t.state)) })
    for (const swarm of [s, one(['blocked']), one(['stalled']), one(['escalated']), one(['blocked', 'escalated'])]) {
      for (let columns = 1; columns <= 140; columns++) {
        const line = swarmHint(swarm, columns) as string
        expect(line.length).toBeLessThanOrEqual(columns)
        expect(line.length).toBeGreaterThan(0)
      }
    }
    // the total is of the three states only: the queued task is never in it
    expect(swarmHint(s, 20)).toBe('SWARM: 4 ATTN')
  })
  test('large counts fit the same forms', () => {
    let big = emptySwarm({ total: 1, sonnet: 1, maxTasks: 512 })
    big = run(add(big, 'holder', { owned: ['*'] }), 'holder')
    for (let n = 0; n < 300; n++) big = admitTask(add(big, `w${n}`, { owned: ['*'] }), `w${n}`, 3000).swarm
    expect(swarmHint(big, WIDE)).toBe('SWARM: 300 BLOCKED · /cockpit agents')
    expect(swarmHint(big, 20)).toBe('SWARM: 300 ATTN')
  })
})

describe('it reads state and keeps none', () => {
  test('the swarm is not changed, and the same state gives the same line', () => {
    const s = busy()
    const before = JSON.stringify(s)
    const first = swarmHint(s, WIDE)
    for (let n = 0; n < 50; n++) expect(swarmHint(s, WIDE)).toBe(first)
    expect(JSON.stringify(s)).toBe(before)
  })
  test('a full swarm costs little per render', () => {
    let s = emptySwarm({ total: 1, sonnet: 1, maxTasks: 512 })
    s = run(add(s, 'holder', { owned: ['*'] }), 'holder')
    for (let n = 0; n < 511; n++) s = n % 2 === 0 ? admitTask(add(s, `w${n}`, { owned: ['*'] }), `w${n}`, 3000).swarm : add(s, `w${n}`)
    const started = Date.now()
    for (let n = 0; n < 2000; n++) swarmHint(s, 80)
    const took = Date.now() - started
    // 2,000 renders of the largest swarm the store allows
    expect(took).toBeLessThan(2000)
  })
})

describe('on the HUD, through the real render hook', () => {
  type Engine = Parameters<typeof start>[0]
  const PLUGIN = 'cobalt-cockpit'
  const ON = { options: { orchestration: true } }
  // the test world's clock when the session starts: a task last seen then has not been quiet for the threshold
  const NOW = 1_000_000
  const mount = ($: Engine, columns: number, maxRows: number, surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({ plugin: PLUGIN, component: 'AbovePrompt' as const, requestId: PLUGIN, surface, props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: columns, scroll: { offset: 0, bodyRows: 12 }, view: {} }, viewport: { columns, rows: 40, isFullscreen: true } } as never)
  const seeded = (on: Parameters<typeof world>[0], swarm: Swarm) => hostState(on, { 'run-ledger': { ...blank(), swarm } })
  const blank = (): Ledger => ({ schema: 2, sessionId: 'hint-session', runs: [], currentRun: null, agents: [], tools: [], turns: {}, warnings: [] } as unknown as Ledger)
  const hintOf = async (hud: { drawn: () => Promise<unknown> }): Promise<string[]> => (await rowsOf(hud)).filter(row => row.startsWith('SWARM'))

  const stripsOf = async (hud: { drawn: () => Promise<unknown> }): Promise<number> => (await rowsOf(hud)).filter(row => /^\s*~+\s*$/.test(row)).length

  test('the line appears while a task is blocked, quiet or escalated, at the width of the band', ON, async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' })); seeded(on, busy(NOW)); await start($)
    const wide = await mount($, 120, 12)
    expect(await hintOf(wide)).toEqual(['SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents'])
    await wide.unmount()
    for (const columns of [80, 60, 50, 40, 30, 24]) {
      const hud = await mount($, columns, 12)
      const rows = await hintOf(hud)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.length).toBeLessThanOrEqual(columns)
      await hud.unmount()
    }
  })
  test('a swarm with nothing to act on adds no row at all', ON, async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' }))
    seeded(on, run(add(add(emptySwarm(), 'q'), 'a'), 'a', NOW)); await start($)
    const hud = await mount($, 120, 12)
    expect((await rowsOf(hud)).filter(row => row.includes('SWARM:'))).toEqual([])
    await hud.unmount()
  })
  test('no swarm at all, and observation mode with an earlier session\'s swarm still in the Ledger: no line', async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' })); seeded(on, busy(NOW)); await start($)
    const hud = await mount($, 120, 12)
    // orchestration is off (the default): the Ledger's blocked tasks are not this session's to act on
    expect((await rowsOf(hud)).filter(row => row.includes('SWARM'))).toEqual([])
    await hud.unmount()
  })
  test('the row is paid for out of the strips\' rows, so the band is never taller for it', ON, async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' })); seeded(on, busy(NOW)); await start($)
    // at 120 columns the main row and the second row are spoken for: a band of one or two rows has no strip row to give up
    for (const maxRows of [1, 2]) {
      const hud = await mount($, 120, maxRows)
      expect([maxRows, await hintOf(hud)]).toEqual([maxRows, []])
      await hud.unmount()
    }
    for (const maxRows of [3, 4, 12]) {
      const hud = await mount($, 120, maxRows)
      expect([maxRows, (await hintOf(hud)).length]).toEqual([maxRows, 1])
      await hud.unmount()
    }
    // below 44 columns there is no second row, so two rows are enough
    const narrow = await mount($, 40, 2)
    expect((await hintOf(narrow)).length).toBe(1)
    await narrow.unmount()
  })
  test('the same band without the swarm\'s trouble draws the same rows, less that one', ON, async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' }))
    const calm = busy(NOW)
    // the same tasks with the three states settled into ones the line does not count
    const settled: Swarm = { ...calm, tasks: calm.tasks.map(t => t.state === 'blocked' ? { ...t, state: 'queued' as const, reason: null } : t.state === 'stalled' ? { ...t, state: 'running' as const, reason: null } : t.state === 'escalated' ? { ...t, state: 'completed' as const, escalation: null } : t) }
    const held = seeded(on, calm); await start($)
    const withLine = await mount($, 120, 12)
    const rowsWith = await rowsOf(withLine)
    await withLine.unmount()
    held.get('run-ledger')!.value = { ...(held.get('run-ledger')!.value as Ledger), swarm: settled }
    const without = await mount($, 120, 12)
    const rowsWithout = await rowsOf(without)
    await without.unmount()
    expect(rowsWith.filter(row => row.startsWith('SWARM'))).toHaveLength(1)
    expect(rowsWithout.filter(row => row.startsWith('SWARM'))).toHaveLength(0)
    expect(rowsWith.filter(row => !row.startsWith('SWARM')).length).toBe(rowsWithout.length)
  })
  test('the desktop surface draws the same words', ON, async ($, on) => {
    world(on); on('session.id', () => ({ value: 'hint-session' })); seeded(on, busy(NOW)); await start($)
    const hud = await mount($, 120, 12, 'desktop')
    expect(await hintOf(hud)).toEqual(['SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents'])
    await hud.unmount()
  })
  test('drawing the line runs no host process that drawing without it does not', ON, async ($, on) => {
    const w = world(on); on('session.id', () => ({ value: 'hint-session' })); const held = seeded(on, busy(NOW)); await start($)
    const count = async (): Promise<number> => { const before = w.runs.length; const hud = await mount($, 120, 12); await rowsOf(hud); await hud.unmount(); return w.runs.length - before }
    await count()                                            // the first draw settles what any draw starts
    const withLine = await count()
    held.get('run-ledger')!.value = { ...(held.get('run-ledger')!.value as Ledger), swarm: emptySwarm() }
    const without = await count()
    expect(withLine).toBe(without)
  })
})
