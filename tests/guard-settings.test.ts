// v0.5.3 L1: another plugin's `$.config.set` cannot change the Stop guard's or the alerts' settings.

import { describe, expect, test } from 'claude-code/testing'
import { hostState, start, world } from './world'

const FIELDS = ['stopGuard', 'verifyScript', 'verifyScriptSha256', 'verifyTimeoutSec', 'stopMaxContinuations', 'stopVolatile', 'stopWatch', 'guardAlerts', 'guardCooldownSec', 'guardMaxAlerts', 'guardRepeat', 'guardRepeatSec', 'guardMaxReminders', 'guardSound', 'guardNotifyKinds', 'guardQuietHours', 'guardQuietTimezone', 'guardQuietOrdinary', 'guardQuietCritical', 'guardDigest', 'guardRecordOnly']
const set = ($: any, key: string, origin: unknown) => $.config.set({ key, value: 'OBSERVE', origin, provider: { plugin: 'cobalt-cockpit', tier: 'user' } } as never)

describe('L1: guard settings are changed only from the config menu', () => {
  for (const f of FIELDS) {
    test(`${f}: a plugin and the bridge are refused`, async ($, on) => {
      world(on); hostState(on, {}); await start($)
      for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'bridge' }, { kind: 'future' }, undefined]) {
        const r = await set($, `cobalt-cockpit.${f}`, origin)
        expect(r.deny).toContain('config menu')
      }
    })
    test(`${f}: the person in the menu is allowed`, async ($, on) => {
      world(on); hostState(on, {}); await start($)
      expect((await set($, `cobalt-cockpit.${f}`, { kind: 'composer' })).deny).toBeUndefined()
    })
  }
  test('other rows are untouched', async ($, on) => {
    world(on); hostState(on, {}); await start($)
    expect((await set($, 'theme', { kind: 'plugin', name: 'other' })).deny).toBeUndefined()
    expect((await set($, 'other-plugin.stopGuard', { kind: 'plugin', name: 'other' })).deny).toBeUndefined()
  })
})
