// Prompt-cache policy: intent read in Claude Code's own order, never written, never claimed as an effect.

import { describe, expect, test } from 'claude-code/testing'
import { LONG_RUNNING_MS, agentsOf, readCache, recommendation } from '../hooks/cache'
import type { CacheInput } from '../hooks/cache'
import { doctorText } from '../hooks/doctor'
import type { DoctorFacts } from '../hooks/doctor'
import { command, planAndComplete, prompt, start, world } from './world'

const base: CacheInput = { version: '2.1.296', forceFiveMinute: undefined, envTtl: undefined, settingTtl: undefined, enableOneHour: undefined }
const read = (over: Partial<CacheInput>) => readCache({ ...base, ...over })

describe('host support', () => {
  test('2.1.242 and later support the controls; earlier ones do not and the settings are ignored', () => {
    expect(read({ version: '2.1.242', settingTtl: '1h' })).toMatchObject({ supported: true, ttl: '1h', source: 'setting' })
    expect(read({ version: '2.1.296' }).supported).toBe(true)
    expect(read({ version: '2.2.0' }).supported).toBe(true)
    const old = read({ version: '2.1.241', settingTtl: '1h', envTtl: '1h' })
    expect(old).toMatchObject({ supported: false, ttl: 'auto', source: 'unsupported' })
    expect(old.notes.join(' ')).toContain('2.1.242')
    expect(recommendation(old, { observed: 3, longRunning: 3 })).toBeNull()
  })
  test('an unknown version is unverified, not unsupported', () => {
    const r = read({ version: null, settingTtl: '1h' })
    expect(r.supported).toBeNull()
    expect(r.ttl).toBe('1h')
    expect(r.notes.join(' ')).toContain('unverified')
  })
})

describe('configuration', () => {
  test('nothing set is the host default, which is 5 minutes for subagents', () => {
    expect(read({})).toMatchObject({ ttl: 'auto', source: 'default', notes: [] })
  })
  test('valid 5m and 1h in the setting and in the environment', () => {
    expect(read({ settingTtl: '5m' })).toMatchObject({ ttl: '5m', source: 'setting' })
    expect(read({ settingTtl: '1h' })).toMatchObject({ ttl: '1h', source: 'setting' })
    expect(read({ envTtl: '5m' })).toMatchObject({ ttl: '5m', source: 'env' })
    expect(read({ envTtl: '1h' })).toMatchObject({ ttl: '1h', source: 'env' })
  })
  test('the number 60 and other values are invalid: ignored by the host and said so', () => {
    for (const bad of [60, '60', 3600, '1H', 'one hour', true, null, {}]) {
      const r = read({ settingTtl: bad })
      expect(r).toMatchObject({ ttl: 'auto', source: 'default' })
      expect(r.notes.join(' ')).toContain('"1h"')
    }
    const env = read({ envTtl: '60' })
    expect(env).toMatchObject({ ttl: 'auto', source: 'default' })
    expect(env.notes.join(' ')).toContain('not a number of minutes')
    expect(read({ envTtl: '' }).notes).toEqual([])
  })
  test('precedence: force 5m, then the environment, then the setting, then ENABLE_PROMPT_CACHING_1H, then the default', () => {
    expect(read({ forceFiveMinute: '1', envTtl: '1h', settingTtl: '1h', enableOneHour: '1' })).toMatchObject({ ttl: '5m', source: 'force_5m_env' })
    expect(read({ envTtl: '5m', settingTtl: '1h', enableOneHour: '1' })).toMatchObject({ ttl: '5m', source: 'env' })
    expect(read({ envTtl: '1h', settingTtl: '5m' })).toMatchObject({ ttl: '1h', source: 'env' })
    expect(read({ settingTtl: '5m', enableOneHour: '1' })).toMatchObject({ ttl: '5m', source: 'setting' })
    expect(read({ enableOneHour: 'true' })).toMatchObject({ ttl: '1h', source: 'enable_1h_env' })
    expect(read({ enableOneHour: '0' })).toMatchObject({ ttl: 'auto', source: 'default' })
  })
  test('a host override forcing 5m is called out when 1h was asked for', () => {
    const r = read({ forceFiveMinute: 'true', settingTtl: '1h' })
    expect(r.ttl).toBe('5m')
    expect(r.notes.join(' ')).toContain('wins over the 1h you configured')
    expect(recommendation(r, { observed: 5, longRunning: 5 })).toContain('cannot take effect')
    expect(read({ forceFiveMinute: '0', settingTtl: '1h' }).ttl).toBe('1h')
  })
  test('a value the reader does not recognise is not guessed at', () => {
    const r = read({ forceFiveMinute: 'maybe', settingTtl: '1h' })
    expect(r.ttl).toBe('1h')
    expect(r.notes.join(' ')).toContain('does not recognise')
  })
})

describe('recommendations', () => {
  const auto = read({})
  test('none are made without evidence', () => {
    expect(recommendation(auto, agentsOf([]))).toContain('nothing to base')
  })
  test('short-lived agents are told the default is likely enough, with no saving claimed', () => {
    const text = recommendation(auto, agentsOf([20_000, 90_000, null]))!
    expect(text).toContain('likely enough')
    expect(text).not.toMatch(/sav|cheaper|reduce/i)
  })
  test('long-running agents get an opt-in suggestion that claims no saving and changes nothing', () => {
    const a = agentsOf([20_000, LONG_RUNNING_MS, 10 * 60_000])
    expect(a).toEqual({ observed: 3, longRunning: 2 })
    const text = recommendation(auto, a)!
    expect(text).toContain('Long-running subagents detected (2 of 3')
    expect(text).toContain('"subagentPromptCacheTtl": "1h"')
    expect(text).toContain('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h')
    expect(text).toContain('billed higher')
    expect(text).toContain('does not show that it lowers cost')
    expect(text).toContain('new session')
  })
  test('already on 1h: the effect is not claimed', () => {
    expect(recommendation(read({ settingTtl: '1h' }), agentsOf([LONG_RUNNING_MS]))).toContain('not reported to plugins')
  })
})

describe('through the host', () => {
  test('doctor reports the policy, writes nothing but telemetry, and sets no variable', async ($, on) => {
    const w = world(on, { settings: { subagentPromptCacheTtl: 60, apiKeyHelper: 'secret-helper', env: { TOKEN: 'sk-hidden' } }, env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' } })
    await start($)
    await prompt($, 'x'); await planAndComplete($, 1)
    const writes = () => Object.keys(w.files)
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('COBALT DOCTOR')
    expect(out).toContain('subagents ask for 1h · from CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
    expect(out).toContain('a number such as 60 is not valid')
    expect(out).toContain('UNKNOWN')
    expect(out).toContain('Cockpit edits no settings file')
    // no secret from settings or the environment reaches the report
    expect(out).not.toMatch(/secret-helper|sk-hidden|TOKEN/)
    // nothing written outside the telemetry directory: no settings file, no config
    expect(writes().every(p => p.includes('/cobalt-cockpit/telemetry/'))).toBe(true)
    expect(w.env['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL']).toBe('1h')
    expect(w.runs.every(r => !['sh', 'bash', 'python3', 'sed', 'tee'].includes(r[0] ?? ''))).toBe(true)
  })
  test('with nothing configured the report says the default and that the effect is unknown', async ($, on) => {
    world(on); await start($)
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('subagents ask for the host default (5 minutes) · from nothing set (host default)')
    expect(out).toContain('effective 5-minute / 1-hour behaviour: UNKNOWN')
  })
  test('an unreadable install record and settings are UNKNOWN, not an error', async ($, on) => {
    world(on); await start($)
    const out = String((await command($, 'doctor')).text)
    expect(out).toContain('installed copies are UNKNOWN')
  })
  test('doctor is read-only for any origin and prints no home directory', async ($, on) => {
    world(on); await start($)
    const out = String((await $.command.run({ command: 'cockpit', args: 'doctor', origin: { kind: 'plugin', name: 'other' }, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
    expect(out).toContain('COBALT DOCTOR')
    expect(out).not.toContain('/home/tester')
  })
})

describe('installation findings', () => {
  const facts = (over: Partial<DoctorFacts>): DoctorFacts => ({
    version: '0.5.2', root: '/home/u/dev/cockpit', home: '/home/u', host: '2.1.296', hostSupported: true, profile: 'SONNET_LED', orchestration: true, reasoning: 'AUTO', router: 'OFF', permissionMode: 'auto',
    installs: [], enabled: [], otherRegistrations: [], telemetry: { enabled: true, dir: '/home/u/.local/state/cobalt-cockpit/telemetry', listed: { files: 1, bytes: 10 }, writes: 1, failures: 0, permissions: 'verified', shed: 0 },
    cache: readCache(base), agents: agentsOf([]), stop: { policy: 'OBSERVE', script: null, pinned: false, timeoutSec: 120, maxAttempts: 3, problems: [], hashed: false, last: null }, ...over,
  })
  test('a development copy beside an enabled install is flagged as a possible double load', () => {
    const text = doctorText(facts({ installs: [{ key: 'cobalt-cockpit@cobalt', version: '0.5.1', path: '/home/u/.claude/plugins/cache/cobalt/cobalt-cockpit/0.5.1' }], enabled: ['cobalt-cockpit@cobalt'] }))
    expect(text).toContain('a development copy is running while an installed Cockpit is also enabled')
    expect(text).toContain('~/dev/cockpit')
  })
  test('the installed copy running alone is clean, and a second registration or install is flagged', () => {
    const path = '/home/u/.claude/plugins/cache/cobalt/cobalt-cockpit/0.5.2'
    const clean = doctorText(facts({ root: path, installs: [{ key: 'cobalt-cockpit@cobalt', version: '0.5.2', path }], enabled: ['cobalt-cockpit@cobalt'] }))
    expect(clean).toContain('the installed copy')
    expect(clean).not.toContain('WARN a development copy')
    const twice = doctorText(facts({ root: path, installs: [{ key: 'cobalt-cockpit@cobalt', version: '0.5.2', path }, { key: 'cobalt-cockpit@other', version: '0.1.0', path: '/x' }], enabled: ['cobalt-cockpit@cobalt', 'cobalt-cockpit@other'], otherRegistrations: [{ root: '/x', provenance: 'cobalt-cockpit@inline' }] }))
    expect(twice).toContain('2 Cockpit installs are recorded')
    expect(twice).toContain('2 Cockpit entries are enabled')
    expect(twice).toContain('another Cockpit registered after this one')
  })
  test('an unsupported host and an unconfirmed storage mode are warnings', () => {
    const text = doctorText(facts({ host: '2.1.100', hostSupported: false, telemetry: { enabled: true, dir: null, listed: null, writes: 0, failures: 3, permissions: 'unverified', shed: 0 } }))
    expect(text).toContain('Cockpit stands by')
    expect(text).toContain('nothing can be recorded')
    expect(text).toContain('permissions NOT confirmed')
  })
})
