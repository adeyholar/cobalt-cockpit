// v0.5.5 verified notification transport: a person-only test notification and its confirmation. NOT TESTED, ATTEMPTED, SENT and
// USER CONFIRMED are told apart, nothing is called delivered, a confirmation stays with its session and connection kind, and
// none of it touches an alert record, the alert budget, a gate, a hold or an approval.

import { describe, expect, test } from 'claude-code/testing'
import { CODE_RE, EMPTY_TRANSPORT, SEEN_WINDOW_MS, TEST_COOLDOWN_MS, CONFIRM_TTL_MS, SOUND_PENDING_MS, TEST_KEEP, TEST_MAX, added, codeOf, confirm, isBellOnly, linkOf, mayTest, statusOf, testMessage, transportLines, validTransport } from '../hooks/transport'
import type { Transport, TransportTest } from '../hooks/transport'
import type { Ledger, Task } from '../types'
import { command, hostState, planAndComplete, plays, progress, start, world } from './world'

const one = (over: Partial<TransportTest> = {}): TransportTest => ({ code: 'ABCD', at: 1000, session: 's1', link: 'local', outcome: 'sent', channel: 'kitty', sound: 'not-requested', ...over })
const of = (...tests: TransportTest[]): Transport => ({ tests })
const armed = { enabled: true, repeat: true }
const text = (lines: string[]) => lines.join('\n')
const codeIn = (w: ReturnType<typeof world>, n = -1): string => /TEST ([A-Z2-9]{4}):/.exec(w.notified.at(n)!.text)![1]!
const held = (h: ReturnType<typeof hostState>): Transport => (h.get('guard-transport')?.value ?? EMPTY_TRANSPORT) as Transport
const say = async ($: any, args: string) => String((await command($, args)).text)
const as = ($: any, args: string, kind: string) => $.command.run({ command: 'cockpit', args, origin: { kind }, presentation: { isFullscreen: true, columns: 120 } } as never) as Promise<{ text?: string }>
/** A session whose id a test can change, as a new session or a resume would. */
const session = (on: any, first = 's1') => { const id = { value: first }; on('session.id', () => ({ value: id.value })); return id }

describe('policy', () => {
  test('a code is four unambiguous characters, whatever the bytes', () => {
    for (const bytes of [[0, 0, 0, 0], [255, 254, 253, 252], [-7, 1.9, Number.NaN, 1e9], []]) expect(codeOf(bytes as number[])).toMatch(CODE_RE)
    expect(codeOf([0, 1, 2, 3])).toBe('ABCD')
    expect(CODE_RE.test('AB1D')).toBe(false)
    expect(CODE_RE.test('ABOD')).toBe(false)
  })
  test('the test text is one closed sentence and the code, and says it is a test', () => {
    expect(testMessage('K7QP')).toBe('Cobalt Guard TEST K7QP: this is a test, not an incident. Nothing is wrong and nothing was changed. If you see this, type /cockpit guard seen K7QP')
  })
  test('the connection kind is read from two variables and nothing else is kept of them', () => {
    expect(linkOf(undefined, undefined)).toBe('local')
    expect(linkOf('', '')).toBe('local')
    expect(linkOf('10.0.0.1 5 10.0.0.2 22', undefined)).toBe('ssh')
    expect(linkOf(undefined, '/dev/pts/3')).toBe('ssh')
    expect(isBellOnly('terminal_bell')).toBe(true)
    expect(isBellOnly('kitty')).toBe(false)
    expect(isBellOnly(null)).toBe(false)
  })
  test('the four states, and never a fifth', () => {
    expect(statusOf(EMPTY_TRANSPORT, 's1', 'local', 3000)).toBe('NOT TESTED')
    expect(statusOf(of(one({ outcome: 'failed', channel: null, why: 'no-channel' })), 's1', 'local', 3000)).toBe('ATTEMPTED')
    expect(statusOf(of(one({ outcome: 'refused', channel: null, why: 'refused' })), 's1', 'local', 3000)).toBe('ATTEMPTED')
    expect(statusOf(of(one()), 's1', 'local', 3000)).toBe('SENT')
    expect(statusOf(of(one({ seenAt: 2000, seenBy: 'code' })), 's1', 'local', 3000)).toBe('USER CONFIRMED')
    const all = text(transportLines(of(one({ seenAt: 2000, seenBy: 'code' })), 's1', 'local', 3000, armed))
    expect(all).not.toMatch(/DELIVERED/i)
    expect(all).toContain('not proof of delivery')
  })
  test('a test has its own rate limit: a cooldown and a per-session cap', () => {
    expect(mayTest(EMPTY_TRANSPORT, 's1', 0)).toEqual({ ok: true })
    expect(mayTest(of(one()), 's1', 1000 + TEST_COOLDOWN_MS - 1)).toEqual({ ok: false, why: 'cooldown', waitSec: 1 })
    expect(mayTest(of(one()), 's1', 1000)).toEqual({ ok: false, why: 'cooldown', waitSec: 30 })
    expect(mayTest(of(one()), 's1', 1000 + TEST_COOLDOWN_MS)).toEqual({ ok: true })
    // a clock that went backwards, or is not a number, waits
    expect(mayTest(of(one({ at: 9e9 })), 's1', 5)).toMatchObject({ ok: false, why: 'cooldown', waitSec: 30 })
    expect(mayTest(of(one()), 's1', Number.NaN)).toMatchObject({ ok: false, why: 'cooldown', waitSec: 30 })
    const full = of(...Array.from({ length: TEST_MAX }, (_, n) => one({ at: n })))
    expect(mayTest(full, 's1', 9e9)).toEqual({ ok: false, why: 'budget' })
    // another session's tests are not this one's
    expect(mayTest(full, 's2', 9e9)).toEqual({ ok: true })
    expect(mayTest(EMPTY_TRANSPORT, '', 0)).toEqual({ ok: false, why: 'unknown-session' })
  })
  test('confirmation: only the latest sent test of this session, once, in time, on the same connection kind, with its own code or none', () => {
    const t = of(one())
    expect(confirm(EMPTY_TRANSPORT, 's1', 'local', '', 2000).result).toBe('none')
    expect(confirm(t, 's2', 'local', 'ABCD', 2000).result).toBe('none')
    expect(confirm(of(one({ outcome: 'failed', channel: null })), 's1', 'local', '', 2000).result).toBe('not-sent')
    expect(confirm(t, 's1', 'local', 'WXYZ', 2000).result).toBe('wrong-code')
    expect(confirm(t, 's1', 'local', 'ab1d!', 2000).result).toBe('bad-code')
    expect(confirm(t, 's1', 'ssh', 'ABCD', 2000).result).toBe('other-link')
    expect(confirm(t, 's1', 'local', 'ABCD', 1000 + SEEN_WINDOW_MS + 1).result).toBe('expired')
    expect(confirm(t, 's1', 'local', 'ABCD', 999).result).toBe('expired')
    expect(confirm(t, 's1', 'local', 'ABCD', Number.NaN).result).toBe('expired')
    for (const r of ['none', 'wrong-code', 'expired'] as const) expect(confirm(t, r === 'none' ? 's2' : 's1', 'local', r === 'wrong-code' ? 'WXYZ' : 'ABCD', r === 'expired' ? 9e9 : 2000).transport).toBe(t)
    const yes = confirm(t, 's1', 'local', ' abcd ', 2000)
    expect(yes.result).toBe('confirmed')
    expect(yes.transport.tests[0]).toMatchObject({ seenAt: 2000, seenBy: 'code' })
    expect(confirm(yes.transport, 's1', 'local', 'ABCD', 3000).result).toBe('already')
    // a channel that shows the text needs its code; only the bell is confirmed without one
    expect(confirm(t, 's1', 'local', '', 2000)).toEqual({ transport: t, result: 'needs-code' })
    expect(confirm(of(one({ channel: 'terminal_bell' })), 's1', 'local', '', 2000).transport.tests[0]).toMatchObject({ seenBy: 'no-code' })
    // an unidentified session owns nothing, whatever is stored
    expect(confirm(of(one({ session: '' })), '', 'local', 'ABCD', 2000).result).toBe('none')
    expect(statusOf(of(one({ session: '', seenAt: 2000, seenBy: 'code' })), '', 'local', 3000)).toBe('NOT TESTED')
    expect(mayTest(of(one({ session: '' })), '', 9e9)).toEqual({ ok: false, why: 'unknown-session' })
    // an older confirmed test does not make a newer one confirmed
    const two = added(yes.transport, one({ code: 'WXYZ', at: 50_000 }))
    expect(statusOf(two, 's1', 'local', 3000)).toBe('SENT')
    expect(confirm(two, 's1', 'local', 'ABCD', 51_000).result).toBe('wrong-code')
  })
  test('a confirmation does not follow the person to another session or another kind of connection', () => {
    const t = of(one({ seenAt: 2000, seenBy: 'code' }))
    expect(statusOf(t, 's1', 'local', 3000)).toBe('USER CONFIRMED')
    expect(statusOf(t, 's2', 'local', 3000)).toBe('NOT TESTED')
    expect(statusOf(t, 's1', 'ssh', 3000)).toBe('SENT')
    expect(text(transportLines(t, 's1', 'ssh', 3000, armed))).toContain('made on a different kind of connection; does not apply now')
    const other = text(transportLines(t, 's2', 'local', 3000, armed))
    expect(other).toContain('TRANSPORT: NOT TESTED')
    expect(other).toContain('an earlier session\'s tests are not counted here')
    expect(other).toContain('WARN transport unverified')
  })
  test('a confirmation ages: after twelve hours it no longer counts, and a clock that went backwards does not count it either', () => {
    const t = of(one({ seenAt: 2000, seenBy: 'code' }))
    expect(statusOf(t, 's1', 'local', 2000 + CONFIRM_TTL_MS)).toBe('USER CONFIRMED')
    expect(statusOf(t, 's1', 'local', 2000 + CONFIRM_TTL_MS + 1)).toBe('SENT')
    expect(statusOf(t, 's1', 'local', 1999)).toBe('SENT')
    expect(statusOf(t, 's1', 'local', Number.NaN)).toBe('SENT')
    const old = text(transportLines(t, 's1', 'local', 2000 + CONFIRM_TTL_MS + 1, armed))
    expect(old).toContain('older than 12h; no longer counted, test again')
    expect(old).toContain('WARN transport unverified')
    expect(text(transportLines(of(one({ link: 'ssh', seenAt: 2000, seenBy: 'code' })), 's1', 'ssh', 3000, armed))).toContain('applies to this session, unless you reconnected since (that cannot be detected)')
  })
  test('a newer test that failed replaces an older confirmation: ATTEMPTED, and the warning returns', () => {
    const t = of(one({ seenAt: 2000, seenBy: 'code' }), one({ code: 'WXYZ', at: 60_000, outcome: 'failed', channel: null, why: 'no-channel' }))
    expect(statusOf(t, 's1', 'local', 61_000)).toBe('ATTEMPTED')
    const out = text(transportLines(t, 's1', 'local', 61_000, armed))
    expect(out).toContain('a newer test has not been confirmed')
    expect(out).toContain('WARN transport unverified')
  })
  test('a sound left as started is reported as unknown once its player must be gone', () => {
    const t = of(one({ sound: 'pending' }))
    expect(text(transportLines(t, 's1', 'local', 1000 + SOUND_PENDING_MS, armed))).toContain('sound started, no player has answered yet')
    expect(text(transportLines(t, 's1', 'local', 1000 + SOUND_PENDING_MS + 1, armed))).toContain('sound outcome unknown')
  })
  test('the diagnostics name the channel, the sound, bell-only, the connection and what is not known', () => {
    const bell = text(transportLines(of(one({ channel: 'terminal_bell', sound: 'bell' })), 's1', 'ssh', 61_000, armed))
    expect(bell).toContain('TRANSPORT: SENT')
    expect(bell).toContain('SENT via terminal_bell')
    expect(bell).toContain('60s ago')
    expect(bell).toContain('terminal bell attempted')
    expect(bell).toContain('the channel is the terminal bell only')
    expect(bell).toContain('connection: SSH')
    expect(bell).toContain('a reconnect cannot be detected')
    expect(bell).toContain('WARN transport unverified: persistent alerts are armed')
    expect(bell).not.toContain('ABCD')
    const none = text(transportLines(of(one({ outcome: 'failed', channel: null, why: 'no-channel', sound: 'none' })), 's1', 'local', 2000, { enabled: false, repeat: false }))
    expect(none).toContain('TRANSPORT: ATTEMPTED')
    expect(none).toContain('ATTEMPTED, not sent (failed: no-channel)')
    expect(none).toContain('the host found no terminal notification channel')
    expect(none).toContain('sound not played')
    expect(none).toContain('no SSH session detected')
    expect(none).not.toContain('WARN transport unverified')
    const ok = text(transportLines(of(one({ seenAt: 2000, seenBy: 'no-code' })), 's1', 'local', 3000, armed))
    expect(ok).toContain('confirmed without the code')
    expect(ok).toContain('applies to this session')
    expect(ok).not.toContain('WARN transport unverified')
    for (const why of ['disabled', 'no-surface'] as const) expect(text(transportLines(of(one({ outcome: 'failed', channel: null, why })), 's1', 'local', 2000, armed))).toMatch(/WARN (notifications are turned off|this session has no terminal)/)
  })
  test('malformed stored transport state is dropped, never believed; the list is bounded', () => {
    const good = one({ seenAt: 5, seenBy: 'code' })
    const bad = [null, 7, 'x', {}, { ...one(), code: 'abcd' }, { ...one(), code: '../../etc' }, { ...one(), at: 'now' }, { ...one(), at: Number.POSITIVE_INFINITY }, { ...one(), session: 5 }, { ...one(), session: '' }, { ...one(), session: 'x'.repeat(200) }, { ...one(), link: 'vpn' },
      { ...one(), outcome: 'delivered' }, { ...one(), channel: 'x'.repeat(40) }, { ...one(), why: 'because' }, { ...one(), sound: 'loud' }, { ...one(), seenAt: 5 }, { ...one(), seenBy: 'code' }, { ...one(), seenAt: 5, seenBy: 'robot' }]
    expect(validTransport({ tests: [good, ...bad] })).toEqual({ tests: [good] })
    for (const x of [undefined, null, 5, 'x', [], { tests: 'x' }, { tests: null }]) expect(validTransport(x)).toEqual(EMPTY_TRANSPORT)
    let t = EMPTY_TRANSPORT
    for (let n = 0; n < 30; n++) t = added(t, one({ at: n }))
    expect(t.tests.length).toBe(TEST_KEEP)
    expect(t.tests.at(-1)!.at).toBe(29)
  })
})

describe('/cockpit guard test', () => {
  test('sends one labelled test, records what the host reported, and needs no task', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($)
    expect(await say($, 'guard')).toContain('TRANSPORT: NOT TESTED')
    const out = await say($, 'guard test')
    expect(w.notified.length).toBe(1)
    expect(w.notified[0]!.text).toMatch(/^Cobalt Guard TEST [A-HJKMNP-Z2-9]{4}: this is a test, not an incident\. Nothing is wrong and nothing was changed\. If you see this, type \/cockpit guard seen [A-HJKMNP-Z2-9]{4}$/)
    expect(w.notified[0]!.title).toBe('Cobalt Guard')
    expect(out).toContain('a TEST notification was SENT via kitty')
    expect(out).toContain('not proof you saw it')
    expect(out).toContain('TRANSPORT: SENT')
    // the code is shown in the notification and nowhere else
    expect(out).not.toContain(codeIn(w))
    expect(await say($, 'guard')).not.toContain(codeIn(w))
    expect(await say($, 'doctor')).not.toContain(codeIn(w))
    expect(held(h).tests).toMatchObject([{ session: 's1', link: 'local', outcome: 'sent', channel: 'kitty', sound: 'not-requested' }])
    expect(h.get('task')?.value ?? null).toBeNull()
  })
  test('a host that does not send is ATTEMPTED, with its reason, and cannot be confirmed', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    w.notifyMode = 'disabled'
    await start($)
    const out = await say($, 'guard test')
    expect(out).toContain('ATTEMPTED and not sent (failed: disabled)')
    expect(out).toContain('TRANSPORT: ATTEMPTED')
    expect(out).toContain('notifications are turned off in Claude Code')
    expect(await say($, 'guard seen')).toContain('the host did not report writing the latest test')
    expect(held(h).tests[0]!.seenAt).toBeUndefined()
  })
  test('a notification that throws is ATTEMPTED (error), and nothing else breaks', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    w.notifyMode = 'throws'
    await start($)
    expect(await say($, 'guard test')).toContain('ATTEMPTED and not sent (failed: error)')
    expect(held(h).tests).toMatchObject([{ outcome: 'failed', why: 'error', channel: null }])
  })
  test('the rate limit: a second test waits, and the session cap ends them', async ($, on) => {
    const w = world(on); session(on)
    await start($)
    await say($, 'guard test')
    expect(await say($, 'guard test')).toContain('try again in 30s. Nothing was sent.')
    expect(w.notified.length).toBe(1)
    for (let n = 1; n < TEST_MAX; n++) { await w.clock.advance(TEST_COOLDOWN_MS); await say($, 'guard test') }
    expect(w.notified.length).toBe(TEST_MAX)
    await w.clock.advance(60 * 60_000)
    expect(await say($, 'guard test')).toContain('used all of its test notifications. Nothing was sent.')
    expect(w.notified.length).toBe(TEST_MAX)
    expect(await say($, 'guard')).toContain(`tests used: ${TEST_MAX} of ${TEST_MAX}`)
  })
  test('is the person\'s alone: an SDK-origin test or confirmation sends and changes nothing', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($)
    expect(String((await as($, 'guard test', 'sdk')).text)).toContain('only by a command you type')
    expect(w.notified).toEqual([])
    await say($, 'guard test')
    const before = JSON.stringify(held(h))
    expect(String((await as($, `guard seen ${codeIn(w)}`, 'sdk')).text)).toContain('only by a command you type')
    expect(JSON.stringify(held(h))).toBe(before)
  })
  test('unknown words are refused and send nothing', async ($, on) => {
    const w = world(on); session(on)
    await start($)
    expect(await say($, 'guard test loud')).toBe('Usage: /cockpit guard test [sound]')
    expect(await say($, 'guard seen a b')).toBe('Usage: /cockpit guard seen [code]')
    expect(w.notified).toEqual([])
  })
})

describe('sound, recorded apart from the notification', () => {
  test('not requested: nothing is played', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test'); await w.clock.settle()
    expect(plays(w, 'checkpoint')).toEqual([])
    expect(held(h).tests[0]!.sound).toBe('not-requested')
  })
  test('`test sound` tries the existing cue and records that a player answered', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test sound'); await w.clock.settle()
    expect(plays(w, 'checkpoint').length).toBe(1)
    expect(held(h).tests[0]).toMatchObject({ outcome: 'sent', sound: 'sound' })
    expect(await say($, 'guard')).toContain('sound attempted (a player exited 0; not proof it was heard)')
  })
  test('guardSound makes a plain test audible too', { options: { guardAlerts: true, guardSound: true } }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test'); await w.clock.settle()
    expect(held(h).tests[0]!.sound).toBe('sound')
  })
  test('no audio player: the terminal bell is what was attempted', async ($, on) => {
    const w = world(on, { players: { sh: 'ok' } }); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test sound'); await w.clock.settle()
    expect(held(h).tests[0]!.sound).toBe('bell')
  })
  test('muted, sounds off, no player at all, or every player failing: recorded as not played, and the notification still stands', async ($, on) => {
    const w = world(on, { players: {} }); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test sound'); await w.clock.settle()
    expect(held(h).tests[0]).toMatchObject({ outcome: 'sent', sound: 'none' })
    await command($, 'mute'); await w.clock.advance(TEST_COOLDOWN_MS)
    await say($, 'guard test sound'); await w.clock.settle()
    expect(held(h).tests[1]).toMatchObject({ outcome: 'sent', sound: 'none' })
    expect(await say($, 'guard')).toContain('sound not played (sounds off, muted, or no player answered)')
  })
  test('sounds off in the configuration', { options: { sounds: false } }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test sound'); await w.clock.settle()
    expect(plays(w, 'checkpoint')).toEqual([])
    expect(held(h).tests[0]!.sound).toBe('none')
  })
  test('every player failing', async ($, on) => {
    const w = world(on, { players: { 'pw-play': 'fails', paplay: 'fails', aplay: 'fails', ffplay: 'fails', mpv: 'fails', play: 'fails', 'canberra-gtk-play': 'fails', afplay: 'fails', sh: 'fails' } }); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test sound'); await w.clock.settle()
    expect(held(h).tests[0]!.sound).toBe('none')
  })
  test('a player that hangs does not hold the command; the sound reads as started', async ($, on) => {
    const w = world(on, { players: { 'pw-play': 'hangs' } }); const h = hostState(on, {}); session(on)
    await start($)
    expect(await say($, 'guard test sound')).toContain('SENT via kitty')
    expect(held(h).tests[0]!.sound).toBe('pending')
    expect(await say($, 'guard')).toContain('sound started, no player has answered yet')
    expect(w.notified.length).toBe(1)
  })
})

describe('/cockpit guard seen', () => {
  test('the code typed back records USER CONFIRMED, as a statement and not as delivery', { options: { guardAlerts: true, guardRepeat: true } }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($)
    expect(await say($, 'guard')).toContain('WARN transport unverified: persistent alerts are armed')
    await say($, 'guard test')
    const out = await say($, `guard seen ${codeIn(w).toLowerCase()}`)
    expect(out).toContain('You confirmed the test notification in this session')
    expect(out).toContain('not proof of delivery')
    expect(out).toContain('TRANSPORT: USER CONFIRMED')
    expect(out).toContain('the code shown was typed back')
    expect(out).not.toMatch(/DELIVERED/i)
    expect(out).not.toContain('WARN transport unverified')
    expect(held(h).tests[0]).toMatchObject({ seenBy: 'code' })
    expect(await say($, 'doctor')).toContain('TRANSPORT: USER CONFIRMED')
  })
  test('a bell-only channel shows no text: it is confirmed without a code and kept as such', async ($, on) => {
    const w = world(on); w.notifyChannel = 'terminal_bell'; const h = hostState(on, {}); session(on)
    await start($)
    const sent = await say($, 'guard test')
    expect(sent).toContain('SENT via terminal_bell')
    expect(sent).toContain('only rings the bell and shows no text')
    expect(sent).toContain('the channel is the terminal bell only')
    expect(await say($, 'guard seen')).toContain('confirmed without the code')
    expect(held(h).tests[0]).toMatchObject({ seenBy: 'no-code', channel: 'terminal_bell' })
  })
  test('a channel that shows the text is not confirmed without its code', async ($, on) => {
    world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test')
    const out = await say($, 'guard seen')
    expect(out).toContain('type the code it showed')
    expect(out).toContain('TRANSPORT: SENT')
    expect(held(h).tests[0]!.seenAt).toBeUndefined()
  })
  test('a confirmation stops counting after twelve hours', { options: { guardAlerts: true } }, async ($, on) => {
    const w = world(on); session(on)
    await start($); await say($, 'guard test'); await say($, `guard seen ${codeIn(w)}`)
    expect(await say($, 'guard')).toContain('TRANSPORT: USER CONFIRMED')
    await w.clock.advance(CONFIRM_TTL_MS + 60_000)
    const out = await say($, 'guard')
    expect(out).toContain('TRANSPORT: SENT')
    expect(out).toContain('no longer counted, test again')
    expect(out).toContain('WARN transport unverified')
  })
  test('with no test, a wrong code or a malformed one, nothing is recorded', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($)
    expect(await say($, 'guard seen')).toContain('there is no test notification in this session to confirm')
    await say($, 'guard test')
    const wrong = codeIn(w) === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
    expect(await say($, `guard seen ${wrong}`)).toContain('that is not the code of the latest test')
    expect(await say($, 'guard seen 12')).toContain('a test code is four letters or digits')
    expect(held(h).tests[0]!.seenAt).toBeUndefined()
    expect(await say($, 'guard')).toContain('TRANSPORT: SENT')
  })
  test('a duplicate confirmation changes nothing', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test'); await say($, `guard seen ${codeIn(w)}`)
    const before = JSON.stringify(held(h))
    await w.clock.advance(5000)
    expect(await say($, `guard seen ${codeIn(w)}`)).toContain('already confirmed; nothing was changed')
    expect(JSON.stringify(held(h))).toBe(before)
  })
  test('a confirmation that comes too late is refused', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test')
    await w.clock.advance(SEEN_WINDOW_MS + 1000)
    expect(await say($, `guard seen ${codeIn(w)}`)).toContain('too old to confirm')
    expect(held(h).tests[0]!.seenAt).toBeUndefined()
  })
  test('the code of an older test does not confirm a newer one', async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test')
    const first = codeIn(w)
    // the codes are random: send again until the latest differs from the first (one more is enough in practice)
    for (let n = 0; n < 4 && (n === 0 || codeIn(w) === first); n++) { await w.clock.advance(TEST_COOLDOWN_MS); await say($, 'guard test') }
    expect(codeIn(w)).not.toBe(first)
    expect(await say($, `guard seen ${first}`)).toContain('that is not the code of the latest test')
    expect(held(h).tests.every(t => t.seenAt === undefined)).toBe(true)
  })
})

describe('session, reload and connection', () => {
  test('a new session starts NOT TESTED: an earlier session\'s confirmation is not attributed to it', { options: { guardAlerts: true } }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); const id = session(on)
    await start($); await say($, 'guard test'); await say($, `guard seen ${codeIn(w)}`)
    expect(await say($, 'guard')).toContain('TRANSPORT: USER CONFIRMED')
    id.value = 's2'
    const out = await say($, 'guard')
    expect(out).toContain('TRANSPORT: NOT TESTED')
    expect(out).toContain('an earlier session\'s tests are not counted here')
    expect(out).toContain('WARN transport unverified')
    // and the old test cannot be confirmed from the new session
    expect(await say($, `guard seen ${codeIn(w)}`)).toContain('there is no test notification in this session')
    expect(held(h).tests.length).toBe(1)
  })
  test('a hot reload keeps the test and its confirmation for the same session', async ($, on) => {
    const seeded = { tests: [one({ at: 999_000, seenAt: 999_500, seenBy: 'code' })] }
    world(on); hostState(on, { 'guard-transport': seeded }); session(on)
    await start($); await start($)
    const out = await say($, 'guard')
    expect(out).toContain('TRANSPORT: USER CONFIRMED')
    expect(out).toContain('applies to this session')
  })
  test('a test pending across a reload can still be confirmed, within its window', async ($, on) => {
    world(on); const h = hostState(on, { 'guard-transport': { tests: [one({ at: 999_000 })] } }); session(on)
    await start($)
    expect(await say($, 'guard seen ABCD')).toContain('You confirmed')
    expect(held(h).tests[0]).toMatchObject({ seenBy: 'code' })
  })
  test('over SSH the transport is reported as unknown beyond the host\'s write, and a local confirmation does not carry over', { options: { guardAlerts: true } }, async ($, on) => {
    world(on, { env: { SSH_CONNECTION: '203.0.113.9 50000 203.0.113.10 22' } }); const h = hostState(on, { 'guard-transport': { tests: [one({ at: 999_000, seenAt: 999_500, seenBy: 'code' })] } }); session(on)
    await start($)
    const out = await say($, 'guard')
    expect(out).toContain('connection: SSH')
    expect(out).toContain('a reconnect cannot be detected, so test again after one')
    expect(out).toContain('made on a different kind of connection; does not apply now')
    expect(out).toContain('WARN transport unverified')
    // nothing of the variable's value is shown or kept
    expect(out).not.toContain('203.0.113')
    await say($, 'guard seen ABCD')
    expect(JSON.stringify(held(h))).not.toContain('203.0.113')
  })
  test('a test sent over SSH is recorded as such and confirmed there', async ($, on) => {
    const w = world(on, { env: { SSH_TTY: '/dev/pts/4' } }); const h = hostState(on, {}); session(on)
    await start($); await say($, 'guard test')
    expect(held(h).tests[0]!.link).toBe('ssh')
    expect(await say($, `guard seen ${codeIn(w)}`)).toContain('TRANSPORT: USER CONFIRMED')
  })
  test('a session that cannot be identified sends nothing and confirms nothing', async ($, on) => {
    const w = world(on); const h = hostState(on, { 'guard-transport': { tests: [one({ at: 999_000 })] } })
    on('session.id', () => { throw new Error('no session') })
    await start($)
    const out = await say($, 'guard test')
    expect(out).toContain('the session could not be identified')
    expect(out).toContain('TRANSPORT: NOT TESTED')
    expect(w.notified).toEqual([])
    expect(await say($, 'guard seen ABCD')).toContain('there is no test notification in this session')
    expect(held(h).tests[0]!.seenAt).toBeUndefined()
  })
  test('/clear starts a new session: its tests are counted afresh and the old confirmation is gone', async ($, on) => {
    const w = world(on); const id = session(on)
    await start($)
    for (let n = 0; n < TEST_MAX; n++) { await say($, 'guard test'); await w.clock.advance(TEST_COOLDOWN_MS) }
    expect(await say($, 'guard test')).toContain('used all of its test notifications')
    id.value = 's2'
    expect(await say($, 'guard')).toContain(`tests used: 0 of ${TEST_MAX}`)
    expect(await say($, 'guard test')).toContain('SENT via kitty')
  })
  test('doctor shows the transport rows, warnings as warnings', { options: { guardAlerts: true } }, async ($, on) => {
    const w = world(on); w.notifyChannel = 'terminal_bell'; session(on)
    await start($); await say($, 'guard test')
    const out = await say($, 'doctor')
    expect(out).toMatch(/INFO\s+TRANSPORT: SENT/)
    expect(out).toMatch(/WARN\s+the channel is the terminal bell only/)
    expect(out).toMatch(/WARN\s+transport unverified: alerts are armed/)
    expect(out).toMatch(/INFO\s+last test: SENT via terminal_bell/)
    expect(out).not.toMatch(/WARN\s+WARN|INFO\s+WARN/)
  })
  test('malformed stored state neither throws nor counts', async ($, on) => {
    const w = world(on); hostState(on, { 'guard-transport': { tests: [{ code: 7 }, null, { ...one(), outcome: 'delivered', seenAt: 1, seenBy: 'code' }] } }); session(on)
    await start($)
    expect(await say($, 'guard')).toContain('TRANSPORT: NOT TESTED')
    expect(await say($, 'guard test')).toContain('SENT via kitty')
    expect(w.notified.length).toBe(1)
  })
})

describe('independence from alerts and verification', () => {
  const OPTS = { options: { guardAlerts: true, guardRepeat: true, guardCooldownSec: 30, guardRepeatSec: 60, guardMaxReminders: 2, guardMaxAlerts: 2 } }
  test('tests use none of the alert budget or cooldown, and leave the alert records and the verdict alone', OPTS, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    for (let n = 0; n < TEST_MAX; n++) { await say($, 'guard test'); await w.clock.advance(TEST_COOLDOWN_MS) }
    expect(w.notified.length).toBe(TEST_MAX)
    const guard = h.get('guard-state')?.value as { count: number; sentAt: number | null } | undefined
    expect(guard?.count ?? 0).toBe(0)
    expect(guard?.sentAt ?? null).toBeNull()
    expect((h.get('run-ledger')!.value as Ledger).alerts ?? []).toEqual([])
    // a test sent a moment ago does not hold a real alert back, and both of the session's two alerts are still there
    await say($, 'guard test')
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
    expect(w.notified.at(-1)!.text).toContain('a security check failed')
    await w.clock.advance(31_000)
    await progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
    expect(w.notified.at(-1)!.text).toContain('the run is blocked')
    expect(((h.get('run-ledger')!.value as Ledger).alerts ?? []).map(a => a.kind)).toEqual(['security-failure', 'run-blocked'])
  })
  test('a test and a confirmation change no gate, hold, review or percentage, and acknowledge no alert', { options: { ...OPTS.options, guardMaxAlerts: 5 } }, async ($, on) => {
    const w = world(on); const h = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    await progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
    const task = () => h.get('task')!.value as Task
    const verdict = () => JSON.stringify([task().gates, task().percent, task().review ?? null, task().stopHold ?? null, task().blocker, (h.get('run-ledger')!.value as Ledger).alerts])
    const before = verdict()
    await say($, 'guard test sound'); await w.clock.settle()
    await say($, `guard seen ${codeIn(w)}`)
    expect(verdict()).toBe(before)
    expect(await say($, 'status')).not.toMatch(/DONE/)
    // the real alert is still unacknowledged, so its reminder still comes
    await w.clock.advance(61_000 + 30_000)
    expect(w.notified.at(-1)!.text).toContain('still open (reminder 1 of 2)')
  })
  test('works with alerts off, and says that nothing is armed', async ($, on) => {
    const w = world(on); session(on)
    await start($)
    const out = await say($, 'guard test')
    expect(w.notified.length).toBe(1)
    expect(out).not.toContain('WARN transport unverified')
    expect(await say($, 'guard')).toContain('GUARD: OFF')
  })
})
