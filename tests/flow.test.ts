// COBALT NEURAL FLOW: states come from real task state, motion only from real activity.

import { describe, expect, test } from 'claude-code/testing'
import { align, discover } from '../hooks/discovery'
import { GLYPH, NODES, flowCells, flowGrid, flowOf, flowRow, flowText, layoutOf } from '../hooks/flow'
import type { FlowInput } from '../hooks/flow'
import { applyAction, newTask, settle } from '../hooks/model'
import type { Task } from '../types'
import { command, planAndComplete, prompt, start, world } from './world'

const NOW = 5_000
const quiet: FlowInput = { task: null, isWorking: false, agents: [], mainTier: null }
const states = (i: Partial<FlowInput>) => flowOf({ ...quiet, ...i }).states
const planned = (done = 0): Task => {
  let t = newTask(1, 'goal', 0, null)
  t = settle(applyAction(t, { action: 'plan', milestones: ['Inspect', 'Implement', 'Test', 'Fix', 'Verify'].map(title => ({ title })) } as never, 1, null).task).task
  for (let n = 1; n <= done; n++) t = settle(applyAction(t, { action: 'complete', milestone: `m${n}` } as never, 2, null).task).task

  return t
}
const text = (i: Partial<FlowInput>, width = 90, motion = false) => flowCells(flowOf({ ...quiet, ...i }), width, { now: NOW, motion })!.map(c => c.ch).join('')

describe('states are derived from real state', () => {
  test('no task: nothing is verified or active', () => {
    expect(states({})).toEqual(Array(6).fill('pending'))
    expect(flowOf(quiet).head).toBe(-1)
  })
  test('a task before any plan: input and discovery are in, routing is next', () => {
    const t = { ...newTask(1, 'goal', 0, null) }
    expect(states({ task: t })).toEqual(['verified', 'verified', 'active', 'pending', 'pending', 'pending'])
  })
  test('a planned task works, then verifies, and only then reads done', () => {
    expect(states({ task: planned(0) })).toEqual(['verified', 'verified', 'verified', 'active', 'pending', 'pending'])
    expect(states({ task: planned(2) })[3]).toBe('active')
  })
  test('a deeper task without criteria is still discovering', () => {
    const t = { ...newTask(1, 'goal', 0, null), discovery: { level: 'DEEP' as const, source: 'auto' as const, reasons: [], objective: null, criteria: [], unknowns: [], risks: [], guided: null } }
    expect(states({ task: t })[1]).toBe('active')
    expect(states({ task: t })[2]).toBe('pending')
  })
  test('a failed milestone fails WORKERS; a failed gate fails VERIFY and never reads done', () => {
    let t = planned(0)
    t = settle(applyAction(t, { action: 'fail', milestone: 'm2', note: 'x' } as never, 3, null).task).task
    expect(states({ task: t })[3]).toBe('failed')
    let g = planned(4)
    g = settle(applyAction(g, { action: 'gate', gate: 'TEST', state: 'fail', evidence: 'x' } as never, 3, null).task).task
    expect(states({ task: g })[4]).toBe('failed')
    expect(states({ task: g })[5]).toBe('pending')
  })
  test('all work done but checks not passed: VERIFY is active and DONE pending', () => {
    const t = planned(5)
    expect(states({ task: t }).slice(3)).toEqual(['verified', 'active', 'pending'])
  })
  test('a mandatory review still owed blocks DONE even when everything else is verified', () => {
    let t = planned(5)
    for (const gate of ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT']) t = settle(applyAction(t, { action: 'gate', gate, state: 'na', evidence: 'fixture' } as never, 4, null).task).task
    const owed = { ...t, review: { state: 'required', grounds: ['release'], ids: [] } as never }
    expect(states({ task: owed })[4]).toBe('verified')
    expect(states({ task: owed })[5]).toBe('blocked')
  })
  test('stale evidence regresses the flow: passed checks taken back reopen VERIFY and DONE', () => {
    let t = planned(5)
    for (const gate of ['CODE', 'TEST', 'TYPE', 'BUILD', 'SECURITY', 'GIT']) t = settle(applyAction(t, { action: 'gate', gate, state: 'na', evidence: 'fixture' } as never, 4, null).task).task
    const before = states({ task: t })
    t = settle(applyAction(t, { action: 'gate', gate: 'TEST', state: 'pending', evidence: 'files changed' } as never, 5, null).task).task
    const after = states({ task: t })
    expect(before[4]).not.toBe('active')
    expect(after[4]).toBe('active')
    expect(after[5]).toBe('pending')
  })
  test('a blocked task marks the stage it is stopping', () => {
    const t = { ...planned(0), status: 'blocked' as const, blocker: 'waiting' }
    expect(states({ task: t })).toContain('blocked')
  })
  void align; void discover
})

describe('activity is only what was observed', () => {
  test('idle: no marker is drawn', () => {
    expect(text({ task: planned(0) })).not.toContain('◆')
  })
  test('a running turn sends one marker into the active node', () => {
    const out = text({ task: planned(0), isWorking: true, mainTier: 'SONNET' })
    expect(out.split('◆').length - 1).toBe(1)
  })
  test('the marker for each tier appears only for an agent observed running of that tier', () => {
    const none = flowCells(flowOf({ ...quiet, task: planned(0), isWorking: true, mainTier: 'SONNET', agents: [{ tier: 'HAIKU', running: false }] }), 90, { now: NOW, motion: true })!
    expect(none.filter(c => c.tone === 'HAIKU')).toHaveLength(0)
    const two = flowCells(flowOf({ ...quiet, task: planned(0), isWorking: true, agents: [{ tier: 'HAIKU', running: true }, { tier: 'OPUS', running: true }] }), 90, { now: NOW, motion: true })!
    expect(two.filter(c => c.ch === '◆').map(c => c.tone).sort()).toEqual(['HAIKU', 'OPUS'])
  })
  test('a running agent alone makes work live even if no turn is running', () => {
    expect(flowOf({ ...quiet, task: planned(0), agents: [{ tier: 'SONNET', running: true }] }).live).toBe(true)
    expect(flowOf({ ...quiet, task: planned(0), agents: [{ tier: 'SONNET', running: false }] }).live).toBe(false)
  })
  test('tiers use their own colours', () => {
    const cells = flowCells(flowOf({ ...quiet, task: planned(0), isWorking: true, mainTier: 'HAIKU' }), 90, { now: NOW, motion: false })!
    expect(cells.some(c => c.tone === 'HAIKU')).toBe(true)
    expect(cells.some(c => c.tone === 'verified')).toBe(true)
  })
})

describe('motion', () => {
  test('the marker moves with time and rests with reduced motion', () => {
    const input = { task: planned(0), isWorking: true, mainTier: 'SONNET' as const }
    const at = (now: number, motion: boolean) => flowCells(flowOf({ ...quiet, ...input }), 90, { now, motion })!.map(c => c.ch).join('').indexOf('◆')
    expect(at(0, true)).not.toBe(at(90 * 3, true))
    expect(at(0, false)).toBe(at(90 * 3, false))
    expect(flowCells(flowOf({ ...quiet, ...input }), 90, { now: 0, motion: false })!.some(c => c.ch === '⣶' || c.ch === '⣤')).toBe(false)
  })
  test('the same frame is byte-identical, so a still flow costs no redraw', () => {
    const f = flowOf({ ...quiet, task: planned(0), isWorking: true })
    expect(flowGrid(f, 90, { now: 1000, motion: true, light: false })!.encode()).toBe(flowGrid(f, 90, { now: 1000, motion: true, light: false })!.encode())
  })
  test('the marker stays inside its edge for every frame', () => {
    const f = flowOf({ ...quiet, task: planned(0), isWorking: true, agents: [{ tier: 'HAIKU', running: true }, { tier: 'SONNET', running: true }, { tier: 'OPUS', running: true }] })
    for (let now = 0; now < 4000; now += 37) {
      const cells = flowCells(f, 90, { now, motion: true })!
      expect(cells.length).toBeLessThanOrEqual(90)
      expect(cells.filter(c => c.ch === '◆').length).toBe(3)
    }
  })
})

describe('layout', () => {
  test('wide, medium, narrow and glyph forms, and nothing when even glyphs do not fit', () => {
    expect(layoutOf(100)!.mode).toBe('full')
    expect(layoutOf(60)!.mode).toBe('short')
    expect(layoutOf(30)!.mode).toBe('glyph')
    expect(layoutOf(20)).toBeNull()
    expect(flowCells(flowOf(quiet), 10, { now: 0, motion: false })).toBeNull()
  })
  test('every width draws no more than its columns, with all six nodes', () => {
    for (let w = 21; w <= 160; w++) {
      const cells = flowCells(flowOf({ ...quiet, task: planned(1), isWorking: true }), w, { now: NOW, motion: true })!
      expect(cells.length).toBeLessThanOrEqual(w)
      const glyphs = cells.filter(c => [...Object.values(GLYPH), '◎'].includes(c.ch)).length
      expect(glyphs).toBeGreaterThanOrEqual(6)
    }
  })
  test('full labels at width; short codes narrower', () => {
    expect(text({ task: planned(0) }, 100)).toContain('DISCOVERY')
    expect(text({ task: planned(0) }, 55)).not.toContain('DISCOVERY')
    expect(text({ task: planned(0) }, 55)).toContain('DSC')
    for (const n of NODES) expect(n.full.length).toBeGreaterThan(0)
  })
  test('state is carried by glyph as well as colour', () => {
    const glyphs = new Set(Object.values(GLYPH))
    expect(glyphs.size).toBe(5)
  })
  test('a text row cuts cleanly and has the same text as the cells', () => {
    const f = flowOf({ ...quiet, task: planned(1), isWorking: true })
    const row = flowRow(f, 90, { now: NOW, motion: false, light: true })!
    expect(row.map(s => s.text).join('')).toBe(text({ task: planned(1), isWorking: true }, 90))
  })
  test('the plain command text spells every state in words, with no colour', () => {
    const out = flowText(flowOf({ ...quiet, task: planned(0), isWorking: true, mainTier: 'SONNET', agents: [{ tier: 'HAIKU', running: true }] }))
    expect(out).toContain('FLOW  ● INPUT → ● DISCOVERY → ● ROUTING → ◉ WORKERS → ○ VERIFY → ○ DONE')
    expect(out).toContain('verified INPUT, DISCOVERY, ROUTING · active WORKERS · pending VERIFY, DONE')
    expect(out).toContain('observed running: HAIKU 1')
    expect(out).toContain('main model SONNET')
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b/)
    expect(flowText(flowOf(quiet))).toContain('no agent observed running · idle · main model UNKNOWN')
  })
})

describe('through the host', () => {
  test('/cockpit flow prints the same reading in words', async ($, on) => {
    world(on); await start($)
    expect(String((await command($, 'flow')).text)).toContain('idle')
    await prompt($, 'x'); await planAndComplete($, 2)
    const out = String((await command($, 'flow')).text)
    expect(out).toContain('FLOW  ● INPUT → ● DISCOVERY → ● ROUTING → ◉ WORKERS')
  })
})
