// SYNTHETIC DEMO capture: drives the real plugin through the offline test host and prints every frame as @@FRAME@@<json>.
// Not part of the test suite: it is copied into a snapshot as tests/demo-capture.test.ts to run (see ../README.md).
import { expect, test } from 'claude-code/testing'
import { hostState, mountHud, prompt, progress, start, world } from './world'

type Engine = Parameters<typeof start>[0]
type Seg = { text: string; color: string | null; bg: string | null; dim: boolean; bold: boolean }
type Row = Seg[]
const SWARM = 'mcp__cobalt-cockpit__swarm'
const PLUGIN = 'cobalt-cockpit'
const DEFAULT = 0x01000000
const hexOf = (n: number): string | null => (n === DEFAULT || n >= 0x01000000 ? null : `#${(n & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`)

const merge = (row: Row): Row => {
  const out: Row = []
  for (const s of row) {
    const last = out[out.length - 1]
    if (last && last.color === s.color && last.bg === s.bg && last.dim === s.dim && last.bold === s.bold) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

type N = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | number | null | undefined
const kids = (n: Exclude<N, string | number | null | undefined>): unknown[] => (n.children ?? (n.props?.['children'] as unknown[] | undefined) ?? []) as unknown[]
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [x])

/** Raster cells to rows of segments. */
const rasterRows = (props: Record<string, unknown>): Row[] => {
  const columns = Number(props['columns']), rows = Number(props['rows'] ?? 1)
  const bytes = Uint8Array.from(atob(String(props['cells'])), c => c.charCodeAt(0))
  const dv = new DataView(bytes.buffer)
  return Array.from({ length: rows }, (_, y) => merge(Array.from({ length: columns }, (_, x) => {
    const i = (y * columns + x) * 12
    const cp = dv.getUint32(i, true)
    return { text: String.fromCodePoint(cp === 0 ? 32 : cp), color: hexOf(dv.getUint32(i + 4, true)), bg: hexOf(dv.getUint32(i + 8, true)), dim: false, bold: false }
  })))
}

type Style = { color: string | null; bg: string | null; dim: boolean; bold: boolean }
const inline = (n: unknown, st: Style, out: Seg[]): void => {
  if (n === null || n === undefined || typeof n === 'boolean') return
  if (typeof n === 'string' || typeof n === 'number') { out.push({ text: String(n), ...st }); return }
  const e = n as Exclude<N, string | number | null | undefined>
  const p = e.props ?? {}
  if (e.type === 'Raster') { for (const r of rasterRows(p)) out.push(...r); return }
  if (e.type === 'Svg') { out.push({ text: `[svg: ${String(p['alt'] ?? '')}]`, ...st }); return }
  if (e.type === 'Button') { out.push({ text: `[${String(p['label'] ?? '')}]`, ...st }); return }
  const next: Style = e.type === 'Text'
    ? { color: typeof p['color'] === 'string' ? p['color'] : st.color, bg: typeof p['backgroundColor'] === 'string' ? p['backgroundColor'] : st.bg, dim: p['dimColor'] === true || st.dim, bold: p['bold'] === true || st.bold }
    : st
  if (e.type === 'Box' && typeof p['marginLeft'] === 'number') out.push({ text: ' '.repeat(p['marginLeft']), ...st })
  for (const c of arr(kids(e))) inline(c, next, out)
}

const plain = (): Style => ({ color: null, bg: null, dim: false, bold: false })
/** The drawing as rows: each child of a column Box is a row; a Raster with several rows is several. */
const rowsFrom = (n: unknown, out: Row[] = []): Row[] => {
  if (n === null || typeof n !== 'object') return out
  const e = n as Exclude<N, string | number | null | undefined>
  const p = e.props ?? {}
  if (e.type === 'Box' && p['flexDirection'] === 'column') { for (const c of arr(kids(e))) rowsFrom(c, out); return out }
  if (e.type === 'Raster' && Number(p['rows'] ?? 1) > 1) { out.push(...rasterRows(p)); return out }
  const segs: Seg[] = []
  inline(e, plain(), segs)
  const text = segs.map(s => s.text).join('')
  if (text === 'engine:AbovePrompt') return out // the mock host's stand-in for the engine's own (empty) band
  out.push(merge(segs))
  return out
}
const findKey = (n: unknown, key: string): Exclude<N, string | number | null | undefined> | undefined => {
  if (n === null || typeof n !== 'object') return undefined
  const e = n as Exclude<N, string | number | null | undefined>
  if (e.props?.['key'] === key) return e
  for (const c of arr(kids(e))) { const f = findKey(c, key); if (f) return f }
  return undefined
}

const emit = (frame: Record<string, unknown>): void => { console.log('@@FRAME@@' + JSON.stringify(frame)) }
const textRows = (text: string): Row[] => text.split('\n').map(line => [{ text: line, color: null, bg: null, dim: false, bold: false }])

test('SYNTHETIC DEMO capture', { options: { orchestration: true, guardAlerts: true } }, async ($: Engine, on) => {
  const w = world(on)
  const held = hostState(on, {})
  await start($)
  const log: string[] = []
  let elapsed = 0
  const advance = async (ms: number) => { elapsed += ms; await w.clock.advance(ms) }

  const hud = async (id: string, step: number, columns: number, isWorking: boolean) => {
    const m = await mountHud($, 'terminal', columns, isWorking)
    emit({ id, step, kind: 'hud', command: null, columns, source: `host render: ui.render AbovePrompt (terminal surface; isWorking=${isWorking}), tree flattened from drawn()`, rows: rowsFrom(await m.drawn()) })
    await m.unmount()
  }
  const huds = async (step: number, isWorking: boolean) => { for (const c of [100, 80, 72]) await hud(`s${step}-hud-${c}`, step, c, isWorking) }
  const slashAt = async (id: string, step: number, name: string, args: string, kind: string, columns: number) => {
    const r = await $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns } })
    const text = String((r as { text?: unknown }).text ?? '')
    emit({ id, step, kind, command: `/${name}${args ? ' ' + args : ''}`, columns, source: `host call: command.run {command:'${name}', args:'${args}', presentation.columns:${columns}}`, rows: textRows(text) })
    return text
  }
  const slash = async (id: string, step: number, name: string, args: string, kind: string) => { await slashAt(`${id}-80`, step, name, args, kind, 80); return slashAt(id, step, name, args, kind, 100) }
  const flowRowNow = async (id: string, step: number, columns = 100) => {
    const m = await mountHud($, 'terminal', columns, true)
    const el = findKey(await m.drawn(), 'neural-flow')
    emit({ id, step, kind: 'flow', command: null, columns, source: 'host render: AbovePrompt Raster key=neural-flow (flowGrid, motion on, dark tones)', elapsedMs: elapsed, rows: el ? rasterRows(el.props!) : [] })
    await m.unmount()
  }
  const pane = async (id: string, step: number, requestId: string, kind: string, columns: number) => {
    const m = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId, props: { title: 'Cockpit', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, viewport: { columns: columns + 40, rows: 60, isFullscreen: true } } as never)
    emit({ id, step, kind, command: requestId === 'cobalt-run-ledger' ? '/ledger' : '/cockpit', columns, source: `host render: ui.render Pane requestId=${requestId} (terminal surface)`, rows: rowsFrom(await m.drawn()) })
    await m.unmount()
  }
  const swarm = (input: Record<string, unknown>) => $.tool.call({ tool: SWARM, ...input } as never)
  let seq = 0
  let at = 0
  /** One tool or host reply, exactly as it came back; `call` is the synthetic input that caused it. */
  const said = (call: string, reply: unknown): void => { emit({ id: `t${String(++seq).padStart(2, '0')}`, step: at, kind: 'tool', command: null, columns: 0, call, source: 'reply of the plugin to a tool call, an agent spawn or a notification, unedited', rows: textRows(typeof reply === 'string' ? reply : JSON.stringify(reply)) }) }
  const P = async (call: string, input: Record<string, unknown>) => { const r = await progress($, input as never); said(`progress ${call}`, r); return r }
  const S = async (call: string, input: Record<string, unknown>) => { const r = await swarm(input); said(`swarm ${call}`, (r as { result?: unknown }).result ?? r); return r }
  const B = async (command: string, id: string) => { const r = await $.tool.call({ tool: 'Bash', command, tool_use_id: id } as never); said(`Bash ${command}`, (r as { result?: unknown }).result ?? r); return r }
  const assign = async (id: string, tier: string, role: string, objective: string, extra: Record<string, unknown> = {}) => {
    await S(`assign ${id} (${tier} ${role})`, { action: 'assign', task_id: id, tier, role, objective, scope: `Scope of ${id}`, spawn_reason: 'Independent bounded assignment (synthetic demo)', ...extra })
  }
  const spawn = async (id: string, type: string) => {
    const r = await $.agent.spawn({ prompt: `Perform task ${id} within its declared scope`, description: `[task:${id}] ${id}`, subagentType: `cobalt-cockpit:${type}`, tool_use_id: `spawn-${id}`, parentModel: 'claude-opus-5-5', provider: { plugin: 'cobalt-cockpit', tier: 'user' }, background: true, fork: false } as never)
    said(`Agent [task:${id}] cobalt-cockpit:${type}`, r)
    return (r as { agentId?: string }).agentId
  }
  const finishAgent = async (agentId: string, taskId: string, conclusion: string, evidence: string[]) => {
    await S(`result ${taskId}`, { action: 'result', task_id: taskId, agentId, conclusion, evidence, changes: [], verification: [], unresolved: [], confidence: 'high' })
    await $.turn.complete({ agentId, turnId: `turn-${agentId}`, reason: 'answer', answer: conclusion, durationMs: 20, isAborted: false } as never)
  }

  // 1. session start, no task
  at = 1
  await huds(1, false)

  // 2. prompt, discover, plan, start m1
  at = 2
  await prompt($, 'DEMO: add per-client rate limiting to the API gateway')
  await $.turn.start({ text: 'DEMO: add per-client rate limiting to the API gateway', turnId: 'main-1' })
  await advance(1000)
  await P('discover (objective, 3 acceptance criteria)', { action: 'discover', objective: 'Each API client is limited to a fixed request rate, enforced at the gateway', criteria: ['A client over its limit receives HTTP 429', 'A client under its limit is unaffected', 'The limiter has unit tests that pass'] })
  await P('plan (5 milestones)', { action: 'plan', goal: 'Add per-client rate limiting to the API gateway', milestones: ['Inspect gateway middleware', 'Implement token-bucket limiter', 'Write limiter tests', 'Fix failures', 'Verify'].map(title => ({ title })) })
  await progress($, { action: 'start', milestone: 'm1' })
  await huds(2, true)

  // 25. RECONNAISSANCE: one Haiku scout, read-only
  at = 25
  await S('wave RECONNAISSANCE', { action: 'wave', wave: 'RECONNAISSANCE' })
  await assign('SCOUT-1', 'HAIKU', 'scout', 'Inventory the gateway middleware chain and where per-request state lives', { mode: 'read', owned_resources: ['/work/example/src/middleware'] })
  const scout = await spawn('SCOUT-1', 'scout')
  await advance(4000)
  await $.tool.call({ tool: 'Read', agentId: scout, file_path: '/work/example/src/middleware/chain.ts', tool_use_id: 'sc-r1' } as never)
  await huds(25, true)

  // 3. ENGINEERING: two Sonnet engineers with separate write scopes, a reviewer that depends on both
  at = 3
  await P('complete m1', { action: 'complete', milestone: 'm1' })
  await progress($, { action: 'start', milestone: 'm2' })
  await S('wave ENGINEERING', { action: 'wave', wave: 'ENGINEERING' })
  await assign('ENG-1', 'SONNET', 'worker', 'Implement the token-bucket limiter', { mode: 'write', owned_resources: ['/work/example/src/limiter.ts'] })
  await assign('ENG-2', 'SONNET', 'worker', 'Write unit tests for the limiter', { mode: 'write', owned_resources: ['/work/example/tests/limiter.test.ts'] })
  await assign('REV-1', 'SONNET', 'reviewer', 'Review the limiter and its tests against the criteria', { mode: 'read', owned_resources: ['/work/example/src/limiter.ts', '/work/example/tests/limiter.test.ts'], dependencies: ['ENG-1', 'ENG-2'] })
  const eng1 = await spawn('ENG-1', 'worker')
  const eng2 = await spawn('ENG-2', 'worker')
  const rev = await spawn('REV-1', 'reviewer')
  log.push(`REV-1 spawn attempt agentId=${String(rev)}`)
  await advance(6000)
  await $.tool.call({ tool: 'Edit', agentId: eng1, file_path: '/work/example/src/limiter.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e1-1' } as never)
  await $.tool.call({ tool: 'Write', agentId: eng2, file_path: '/work/example/tests/limiter.test.ts', content: 'x', tool_use_id: 'e2-1' } as never)
  await advance(3000)
  await huds(3, true)
  for (let i = 0; i < 8; i++) { await hud(`s3-tick-${i}`, 3, 100, true); await flowRowNow(`s3-flow-row-${i}`, 3, 100); await advance(90) }
  await slash('s3-agents', 3, 'cockpit', 'agents', 'command')
  await slash('s3-agents-rev1', 3, 'cockpit', 'agents REV-1', 'command')
  await slash('s3-agents-eng1', 3, 'cockpit', 'agents ENG-1', 'command')
  await slash('s3-flow', 3, 'cockpit', 'flow', 'command')

  // 4. m2 and m3 complete; the agents report; the commander verifies ENG-1 only
  at = 4
  await advance(5000)
  await P('complete m2', { action: 'complete', milestone: 'm2' })
  await progress($, { action: 'start', milestone: 'm3' })
  await advance(5000)
  await P('complete m3', { action: 'complete', milestone: 'm3' })
  await finishAgent(eng1!, 'ENG-1', 'Token-bucket limiter implemented in src/limiter.ts', ['src/limiter.ts exports createLimiter(rate, burst)'])
  await finishAgent(eng2!, 'ENG-2', 'Limiter tests written in tests/limiter.test.ts', ['tests/limiter.test.ts has 6 cases'])
  await finishAgent(scout!, 'SCOUT-1', 'Gateway middleware chain mapped; per-request state is in ctx.client', ['src/middleware/chain.ts:12 chain order'])
  await S('verify ENG-1 pass', { action: 'verify', task_id: 'ENG-1', state: 'pass', evidence: 'commander read src/limiter.ts and traced the refill path' })
  await advance(2000)
  await huds(4, true)
  await slash('s4-agents', 4, 'cockpit', 'agents', 'command')

  // 5. a failing test command: the TEST gate is read from its exit status
  at = 5
  await progress($, { action: 'start', milestone: 'm4' })
  w.failing = /npm test/
  await B('npm test', 'bash-test-1')
  await advance(1000)
  await P('status', { action: 'status' })
  await huds(5, true)
  await slash('s5-ready', 5, 'cockpit', 'ready', 'command')
  await slash('s5-status', 5, 'cockpit', 'status', 'command')
  await pane('s5-pane-100', 5, 'cobalt-cockpit', 'pane', 100)

  // 55. the run is blocked on a person: the HUD, the guard and the alert inbox
  at = 55
  await P('block m4', { action: 'block', milestone: 'm4', note: 'Owner decision needed: burst size for unauthenticated clients' })
  await advance(1000)
  for (const n of w.notified) said(`ui.notify (${String(n.title)})`, n.text)
  await huds(55, true)
  await slash('s55-ready', 55, 'cockpit', 'ready', 'command')
  await slash('s55-alerts', 55, 'cockpit', 'alerts', 'command')
  await slash('s55-guard', 55, 'cockpit', 'guard', 'command')
  await P('unblock m4', { action: 'unblock', milestone: 'm4' })
  await advance(1000)

  // 6. recovery: the commands pass, the remaining results are verified, the gates and the goal check hold
  at = 6
  w.failing = null
  await B('npm test', 'bash-test-2')
  await B('npx tsc --noEmit', 'bash-type')
  await B('npm run build', 'bash-build')
  await P('complete m3', { action: 'complete', milestone: 'm3' })
  await P('complete m4', { action: 'complete', milestone: 'm4' })
  await S('verify ENG-2 pass', { action: 'verify', task_id: 'ENG-2', state: 'pass', evidence: 'commander ran npm test: limiter.test.ts 6 pass' })
  await S('verify SCOUT-1 pass', { action: 'verify', task_id: 'SCOUT-1', state: 'pass', evidence: 'commander spot-checked src/middleware/chain.ts' })
  await S('wave REVIEW', { action: 'wave', wave: 'REVIEW' })
  const rev2 = await spawn('REV-1', 'reviewer')
  log.push(`REV-1 second spawn agentId=${String(rev2)}`)
  if (rev2) {
    await advance(3000)
    await finishAgent(rev2, 'REV-1', 'Limiter and tests satisfy all three criteria', ['limiter.ts refill logic', 'limiter.test.ts 6 cases'])
    await S('verify REV-1 pass', { action: 'verify', task_id: 'REV-1', state: 'pass', evidence: 'commander read the review and the cited lines' })
  }
  for (const [gate, state, evidence] of [
    ['CODE', 'pass', 'src/limiter.ts and tests/limiter.test.ts reviewed by REV-1, no open findings'],
    ['SECURITY', 'na', 'no new dependency, no secret, no auth path touched'],
    ['GIT', 'pass', 'git status: only src/limiter.ts and tests/limiter.test.ts changed'],
  ] as const) await P(`gate ${gate} ${state}`, { action: 'gate', gate, state, evidence })
  await P('align ALIGNED (c1, c2, c3 with evidence)', { action: 'align', alignment: { state: 'ALIGNED', demonstrated: [
    { id: 'c1', evidence: "test 'returns 429 over limit' in tests/limiter.test.ts passes (npm test, 6 pass)" },
    { id: 'c2', evidence: "test 'leaves a client under its limit unaffected' in tests/limiter.test.ts passes (npm test, 6 pass)" },
    { id: 'c3', evidence: 'tests/limiter.test.ts: 6 pass, 0 fail (npm test exit 0)' },
  ] } })
  await P('complete m5', { action: 'complete', milestone: 'm5' })
  await advance(1000)
  await huds(6, true)
  await slash('s6-ready', 6, 'cockpit', 'ready', 'command')
  await slash('s6-flow', 6, 'cockpit', 'flow', 'command')
  await flowRowNow('s6-flow-row', 6, 100)
  await pane('s6-pane-100', 6, 'cobalt-cockpit', 'pane', 100)
  await slash('s6-agents', 6, 'cockpit', 'agents', 'command')
  await pane('s6-ledger', 6, 'cobalt-run-ledger', 'ledger', 100)

  // 7. the main turn ends; the band at rest
  at = 7
  await $.turn.complete({ turnId: 'main-1', reason: 'answer', answer: 'Done.', durationMs: 20, isAborted: false } as never)
  await advance(1000)
  await huds(7, false)
  await slash('s7-ready', 7, 'cockpit', 'ready', 'command')
  await slash('s7-status', 7, 'cockpit', 'status', 'command')
  for (const l of log) console.log('@@LOG@@' + l)
  console.log('@@OUTBOUND@@' + JSON.stringify(w.outbound))
  expect(w.outbound).toEqual([])
})
