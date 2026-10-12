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
const trusted = (h: ReturnType<typeof hostState>) => JSON.stringify(h.get('guard-trust')?.value ?? null)

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

describe('M1: an SDK-origin command changes nothing', () => {
  test('reset does not abandon a held task', { ...guard }, async ($, on) => {
    const { h } = await held($, on)
    const out = String((await run($, 'reset', SDK)).text)
    expect(out).toContain('only by a command you type')
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('guard release does not lift the hold', { ...guard }, async ($, on) => {
    const { h } = await held($, on)
    const out = String((await run($, 'guard release', SDK)).text)
    expect(out).toContain('nothing was changed')
    expect(taskOf(h).stopHold).toBeDefined()
  })
  test('guard untrust does not remove the enrollment', { ...guard }, async ($, on) => {
    const { h } = await held($, on)
    const before = trusted(h)
    expect(String((await run($, 'guard untrust', SDK)).text)).toContain('nothing was changed')
    expect(trusted(h)).toBe(before)
  })
  test('guard trust does not enroll a verifier', { ...guard }, async ($, on) => {
    const { h, sha } = await held($, on)
    await command($, 'guard untrust')
    const before = trusted(h)
    expect(String((await run($, `guard trust ${sha.slice(0, 12)}`, SDK)).text)).toContain('nothing was changed')
    expect(trusted(h)).toBe(before)
  })
  test('guard ack and silence do not touch alerts', { ...guard }, async ($, on) => {
    await held($, on)
    for (const a of ['guard ack', 'guard silence']) expect(String((await run($, a, SDK)).text)).toContain('nothing was changed')
  })
  test('discovery and router are not switched', { ...guard }, async ($, on) => {
    world(on); const h = hostState(on, {}); await start($)
    expect(String((await run($, 'discovery light', SDK)).text)).toContain('nothing was changed')
    expect(String((await run($, 'router jev', SDK)).text)).toContain('nothing was changed')
    expect(h.get('discovery-pin')?.value ?? null).toBeNull()
  })
})

describe('M1: the person channels still work', () => {
  for (const kind of ['composer', 'bridge']) {
    test(`${kind} can release a held task and reset`, { ...guard }, async ($, on) => {
      const { h } = await held($, on)
      expect(String((await run($, 'guard release', { kind })).text)).toContain('released')
      expect(taskOf(h).stopHold).toBeUndefined()
      expect(String((await run($, 'reset', { kind })).text)).toContain('cleared')
    })
  }
})
