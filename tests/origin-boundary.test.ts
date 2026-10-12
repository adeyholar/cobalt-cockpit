// v0.5.3 M1: the SDK origin is not human authority. `claude -p` run by an agent-controlled process reaches the host as
// `sdk`, and the host cannot say whether a person or an agent started it, so every privileged command refuses it.

import { describe, expect, test } from 'claude-code/testing'
import type { Task } from '../types'
import { command, hostState, planAndComplete, start, world } from './world'

const SCRIPT = '/work/check.sh'
const SUMMARY = 'Changed the parser to reject empty input and added a regression test for the empty case.'
const guard = { options: { stopGuard: 'ENFORCE', verifyScript: SCRIPT, stopMaxContinuations: 1 } }
const stop = ($: any) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: SUMMARY }) as Promise<{ block?: string }>
const run = ($: any, args: string, origin: unknown) => $.command.run({ command: 'cockpit', args, origin, presentation: { isFullscreen: true, columns: 120 } } as never)
const taskOf = (h: ReturnType<typeof hostState>) => h.get('task')!.value as Task

/** A held task whose verifier a person enrolled. */
const held = async ($: any, on: any) => {
  const w = world(on); w.files[SCRIPT] = 'exit 1'; w.players[SCRIPT] = 'fails'
  const h = hostState(on, {})
  await start($); await planAndComplete($, 1)
  const sha = /sha-256  ([0-9a-f]{64})/.exec(String((await command($, 'guard trust')).text))![1]!
  await command($, `guard trust ${sha.slice(0, 12)}`)
  await stop($)
  expect(taskOf(h).stopHold).toBeDefined()

  return { w, h, sha }
}

const SDK = { kind: 'sdk' }
const KEYS = ['task', 'guards', 'guard-state', 'discovery-pin', 'router', 'stop-owed']
/** Everything a privileged command could change: the host state atoms, the durable trust and check stores, and the ledger's alerts and checks. */
const lastWrite = (w: ReturnType<typeof world>, key: string) => w.storeWrites.filter(x => x.key === key).at(-1)?.value ?? null
const protectedState = (w: ReturnType<typeof world>, h: ReturnType<typeof hostState>) => JSON.stringify({
  atoms: KEYS.map(k => h.get(k)?.value ?? null),
  ledger: ((l: any) => ({ alerts: l?.alerts ?? null, checks: l?.stopChecks ?? null }))(h.get('run-ledger')?.value),
  trust: lastWrite(w, 'stop-trust'),
  checks: lastWrite(w, 'stop-checks'),
})
const enrolled = (w: ReturnType<typeof world>): number => Object.keys((lastWrite(w, 'stop-trust') ?? {}) as object).length

describe('M1: an SDK-origin command changes nothing', () => {
  test('the fixture really enrolls a verifier and holds the task', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    expect(enrolled(w)).toBe(1)
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('control: the same observation sees a composer untrust and a composer release', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    await run($, 'guard untrust', { kind: 'composer' })
    expect(enrolled(w)).toBe(0)
    await run($, 'guard release', { kind: 'composer' })
    expect(taskOf(h).stopHold).toBeUndefined()
    expect(protectedState(w, h)).not.toBe(before)
  })
  test('reset does not abandon a held task', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    expect(String((await run($, 'reset', SDK)).text)).toContain('only by a command you type')
    expect(taskOf(h).stopHold).toBeDefined()
    expect(protectedState(w, h)).toBe(before)
  })
  test('guard release does not lift the hold', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    expect(String((await run($, 'guard release', SDK)).text)).toContain('nothing was changed')
    expect(taskOf(h).stopHold).toBeDefined()
    expect(protectedState(w, h)).toBe(before)
  })
  test('guard untrust does not remove the enrollment', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    expect(String((await run($, 'guard untrust', SDK)).text)).toContain('nothing was changed')
    expect(enrolled(w)).toBe(1)
    expect(protectedState(w, h)).toBe(before)
  })
  test('guard trust does not enroll a verifier', { ...guard }, async ($, on) => {
    const { w, h, sha } = await held($, on)
    await command($, 'guard untrust')
    expect(enrolled(w)).toBe(0)
    const before = protectedState(w, h)
    expect(String((await run($, `guard trust ${sha.slice(0, 12)}`, SDK)).text)).toContain('nothing was changed')
    expect(enrolled(w)).toBe(0)
    expect(protectedState(w, h)).toBe(before)
  })
  test('guard ack and silence do not touch alerts or the guard state', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    for (const a of ['guard ack', 'guard silence']) expect(String((await run($, a, SDK)).text)).toContain('nothing was changed')
    expect(protectedState(w, h)).toBe(before)
  })
  test('discovery and router are not switched', { ...guard }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); await start($)
    const before = protectedState(w, h)
    expect(String((await run($, 'discovery light', SDK)).text)).toContain('nothing was changed')
    expect(String((await run($, 'router jev', SDK)).text)).toContain('nothing was changed')
    expect(protectedState(w, h)).toBe(before)
    expect((h.get('discovery-pin')?.value ?? null)).toBeNull()
    expect(((h.get('router')?.value ?? { mode: 'OFF' }) as { mode: string }).mode).toBe('OFF')
  })
  test('every other non-human origin is refused the same way', { ...guard }, async ($, on) => {
    const { w, h } = await held($, on)
    const before = protectedState(w, h)
    for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'task-notification' }, { kind: 'channel', server: 's' }, { kind: 'future' }, null, undefined]) {
      for (const args of ['reset', 'guard release', 'guard untrust', 'guard ack', 'guard silence']) await run($, args, origin)
    }
    expect(protectedState(w, h)).toBe(before)
  })
})

describe('M1: the person channels still work', () => {
  for (const kind of ['composer', 'bridge']) {
    test(`${kind} can release a held task and reset`, { ...guard }, async ($, on) => {
      const { w, h } = await held($, on)
      expect(String((await run($, 'guard release', { kind })).text)).toContain('released')
      expect(taskOf(h).stopHold).toBeUndefined()
      expect(String((await run($, 'reset', { kind })).text)).toContain('cleared')
    })
  }
})
