// v0.5.7 alert inbox: the kept alert records read as occurrences, acknowledged one at a time, kept for the project across
// sessions, and shown on the HUD as a count. Nothing here changes a verdict, and no line says a person saw anything.
// These are synthetic: no test here shows that a person saw, heard or was spared anything.

import { describe, expect, test } from 'claude-code/testing'
import { ALERT_CAP, EMPTY_GUARD, ID_RE, INBOX_PAGE, ackOccurrence, bounded, decide, episodesOf, guardConfigOf, inboxOrder, inboxPages, inboxText, isAlertRecord, isSettledQuietly, occurrencesOf, pinLine, pinsOf, remind, unreadOf, validAlerts, withAck } from '../hooks/alerts'
import type { AlertKind, AlertRecord, Open } from '../hooks/alerts'
import { emptyLedger, migrateLedger } from '../hooks/ledger'
import { applyAction, newTask, settle } from '../hooks/model'
import type { Ledger, Task } from '../types'
import { FIVE, command, hostState, mountHud, planAndComplete, progress, rowsOf, start, world } from './world'

const MIN = 60_000
const HOUR = 60 * MIN
const rec = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => ({ key, kind: 'run-blocked', taskId: 1, at: 1000, outcome: 'sent', attempts: 1, channel: 'kitty', ...over })
const resolved = (key: string, over: Partial<AlertRecord> = {}): AlertRecord => rec(key, { outcome: 'resolved', attempts: 0, channel: null, ...over })
/** Records written through `bounded`, as the engine writes them, so they carry ids. */
const written = (...rs: AlertRecord[]): AlertRecord[] => rs.reduce<AlertRecord[]>((all, r) => bounded(all, r), [])
const K = (uid: string, kind: AlertKind, detail: string) => `${uid}:${kind}:${detail}`
const open = (...keys: [string, AlertKind][]): Open[] => keys.map(([key, kind]) => ({ key, kind }))
const NEVER_CLAIMED = /\b(seen|heard|delivered|read by|missed|silent(ly)?|disconnect(ed)?|reconnect(ed)?)\b/i
const ledger = (held: ReturnType<typeof hostState>) => held.get('run-ledger')!.value as Ledger
const task = (held: ReturnType<typeof hostState>) => held.get('task')!.value as Task
const say = async ($: any, args: string) => String((await command($, args)).text)
const sayAs = async ($: any, args: string, origin: unknown) => String(((await $.command.run({ command: 'cockpit', args, origin, presentation: { isFullscreen: true, columns: 120 } } as never)) as { text?: string }).text)
const failSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'fail', evidence: 'x' })
const passSecurity = ($: any) => progress($, { action: 'gate', gate: 'SECURITY', state: 'pass', evidence: 'x' })
const block = ($: any) => progress($, { action: 'block', milestone: 'm2', note: 'needs the owner' })
const unblock = ($: any) => progress($, { action: 'unblock', milestone: 'm2' })
const idOf = (text: string, kind: string): string => new RegExp(`\\b([0-9a-f]{8}) (?:CRITICAL|HIGH|NORMAL) ${kind}\\b`).exec(text)?.[1] ?? 'none'
const ids = (text: string): string[] => [...text.matchAll(/^ {2}([0-9a-f]{8}) (?:CRITICAL|HIGH|NORMAL) /gm)].map(m => m[1] as string)
const guardRow = async ($: any, columns = 120) => (await rowsOf(await mountHud($, 'terminal', columns))).find(r => r.includes('GUARD') || r.includes('▲'))
const armed = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20, ...extra } })
const session = (on: any, id = 's1') => on('session.id', () => ({ value: id }))
const KEEP = 'alert-history'
const lastStored = (w: ReturnType<typeof world>, key: string): any => w.storeWrites.filter(s => s.key === key).at(-1)?.value
const blockedTask = (): Task => {
  let t = newTask(1, 'goal', 100, null)
  t = settle(applyAction(t, { action: 'plan', milestones: FIVE.slice(0, 3) } as never, 101, null).task).task

  return settle(applyAction(t, { action: 'block', milestone: 'm1', note: 'needs the owner' } as never, 102, null).task).task
}
const projectHash = async (cwd: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cobalt-cockpit/alerts/v1\0${cwd}`)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
const keyOfTask = (t: Task) => `${t.id}@${t.startedAt}:run-blocked:task`

describe('occurrence identity', () => {
  test('a record is stamped with an 8-hex id as it is written; a later record of the same occurrence carries the same one', () => {
    const k = K('u1', 'run-blocked', 'task')
    const kept = written(rec(k), rec(k, { at: 2000, nth: 1 }))
    expect(kept[0]!.id).toMatch(ID_RE)
    expect(kept[1]!.id).toBe(kept[0]!.id)
  })
  test('a condition that resolved and holds again is a new occurrence with a new id; another condition has its own', () => {
    const k = K('u1', 'run-blocked', 'task')
    const kept = written(rec(k), resolved(k, { at: 2000 }), rec(k, { at: 3000 }), rec(K('u1', 'security-failure', 'SECURITY'), { kind: 'security-failure', at: 3500 }))
    expect(new Set(kept.map(r => r.id)).size).toBe(3)
    expect(kept[1]!.id).toBe(kept[0]!.id)
    expect(episodesOf(kept).map(e => e.records.length)).toEqual([2, 1, 1])
  })
  test('the same key and moment in another task (an id reused after a reset) never share an id: keys carry the task\'s identity', () => {
    const a = written(rec(K('1@100', 'run-blocked', 'task')))[0]!.id
    const b = written(rec(K('1@900', 'run-blocked', 'task')))[0]!.id
    expect(a).not.toBe(b)
  })
  test('a record from before v0.5.7 gets the id it would have been stamped with, and keeps it as records are added', () => {
    const k = K('u1', 'run-blocked', 'task')
    const stamped = written(rec(k))
    const legacy = [{ ...stamped[0]! }]
    delete legacy[0]!.id
    expect(episodesOf(legacy)[0]!.id).toBe(stamped[0]!.id)
    const more = bounded(legacy, rec(k, { at: 2000, nth: 1 }))
    expect(more[1]!.id).toBe(stamped[0]!.id)
    expect(episodesOf(more)).toHaveLength(1)
  })
  test('the id survives the eviction of the records that came before it in the same occurrence', () => {
    const k = K('u1', 'run-blocked', 'task')
    let kept = written(rec(k, { outcome: 'throttled', channel: null, attempts: 0, why: 'cooldown' }), rec(k, { at: 2000 }))
    const id = kept[0]!.id
    for (let i = 0; i < ALERT_CAP; i++) kept = bounded(kept, rec(K('u1', 'review-hold', `r${i}`), { kind: 'review-hold', at: 3000 + i, outcome: 'throttled', channel: null, attempts: 0, why: 'budget' }))
    const mine = episodesOf(kept).find(e => e.key === k)!
    expect(mine.id).toBe(id)
    expect(kept.length).toBeLessThanOrEqual(ALERT_CAP)
  })
  test('two occurrences that claim one id (a damaged store) are told apart: the older keeps it', () => {
    const a = rec(K('u1', 'run-blocked', 'task'), { id: 'abcdef01' })
    const b = rec(K('u2', 'run-blocked', 'task'), { id: 'abcdef01', at: 2000 })
    const eps = episodesOf([a, b])
    expect(eps[0]!.id).toBe('abcdef01')
    expect(eps[1]!.id).toMatch(ID_RE)
    expect(eps[1]!.id).not.toBe('abcdef01')
  })
  test('a stored id that is not 8 lowercase hex digits is dropped with its record, never believed', () => {
    const good = rec('k', { id: '0123abcd' })
    expect(isAlertRecord(good)).toBe(true)
    for (const bad of ['0123ABCD', '0123abc', '0123abcde', 'zzzzzzzz', '', 7, null, '../../etc']) expect(isAlertRecord({ ...good, id: bad })).toBe(false)
    expect(validAlerts([good, { ...good, id: 'nope' }])).toEqual([good])
  })
})

describe('the inbox model', () => {
  const sec = K('u1', 'security-failure', 'SECURITY')
  const blk = K('u1', 'run-blocked', 'task')
  const rev = K('u1', 'review-hold', 'review')
  const kept = written(
    rec(blk, { at: 1000 }),
    rec(sec, { kind: 'security-failure', at: 2000, taskId: 1 }),
    rec(rev, { kind: 'review-hold', at: 3000, outcome: 'deferred', channel: null, attempts: 0, why: 'quiet' }),
  )
  test('open and unacknowledged come first, the gravest first; then open and acknowledged; then what no longer holds, newest first', () => {
    const history = written(rec('old:run-blocked:task', { at: 10, taskId: 7 }), resolved('old:run-blocked:task', { at: 20, taskId: 7 }), rec('old2:run-blocked:task', { at: 30, taskId: 8 }))
    const all = [...history, ...kept]
    const occ = occurrencesOf(all, open([blk, 'run-blocked'], [sec, 'security-failure'], [rev, 'review-hold']))
    expect(inboxOrder(occ).map(o => `${o.kind}:${o.state}`)).toEqual(['security-failure:open', 'review-hold:open', 'run-blocked:open', 'run-blocked:ended', 'run-blocked:resolved'])
    const acked = ackOccurrence(all, open([blk, 'run-blocked'], [sec, 'security-failure'], [rev, 'review-hold']), occ.find(o => o.kind === 'security-failure')!.id).alerts
    expect(inboxOrder(occurrencesOf(acked, open([blk, 'run-blocked'], [sec, 'security-failure'], [rev, 'review-hold']))).map(o => `${o.kind}:${o.acked}`).slice(0, 3)).toEqual(['review-hold:false', 'run-blocked:false', 'security-failure:true'])
  })
  test('each occurrence carries level, task, outcome, channel, reminders, acknowledgment and whether the condition holds', () => {
    const k = K('u2', 'release-no-go', 'release')
    const occ = occurrencesOf(written(rec(k, { kind: 'release-no-go', taskId: 4, channel: 'ghostty' }), rec(k, { kind: 'release-no-go', taskId: 4, at: 2000, nth: 1, channel: 'ghostty' })), open([k, 'release-no-go']))[0]!
    expect(occ).toMatchObject({ kind: 'release-no-go', level: 'HIGH', taskId: 4, status: 'sent', channel: 'ghostty', reminders: 1, acked: false, state: 'open', at: 1000, lastAt: 2000 })
  })
  test('the status names what became of the notification, and a held-back one is never called missed', () => {
    const one = (r: Partial<AlertRecord>) => occurrencesOf(written(rec('k:run-blocked:task', r)), [])[0]!.status
    expect(one({})).toBe('sent')
    expect(one({ outcome: 'failed', channel: null, why: 'error' })).toBe('not-sent')
    expect(one({ outcome: 'refused', channel: null, why: 'refused' })).toBe('not-sent')
    expect(one({ outcome: 'deferred', channel: null, why: 'quiet' })).toBe('deferred')
    expect(one({ outcome: 'throttled', channel: null, why: 'cooldown' })).toBe('held')
    expect(one({ outcome: 'silenced', channel: null, why: 'kind-off' })).toBe('kind-off')
    expect(one({ outcome: 'silenced', channel: null })).toBe('silenced')
  })
  test('the unread count is what was recorded, no longer holds and was never acknowledged', () => {
    const a = written(rec('a:run-blocked:task'), rec('b:run-blocked:task', { at: 2000 }), rec('c:run-blocked:task', { at: 3000 }))
    const withAcked = ackOccurrence(a, [], episodesOf(a)[2]!.id).alerts
    expect(unreadOf(occurrencesOf(withAcked, open(['a:run-blocked:task', 'run-blocked'])))).toBe(1)
    expect(unreadOf(occurrencesOf(withAcked, []))).toBe(2)
  })
  test('a page holds a bounded number of lines; the footer says where the rest is; an out-of-range page is clamped', () => {
    let many: AlertRecord[] = []
    for (let i = 0; i < 20; i++) many = bounded(many, rec(`t${i}:run-blocked:task`, { at: 1000 + i, taskId: i + 1 }))
    const occ = occurrencesOf(many, [])
    expect(inboxPages(occ.length)).toBe(Math.ceil(occ.length / INBOX_PAGE))
    const first = inboxText(occ, 1, 5000, true)
    expect(ids(first)).toHaveLength(INBOX_PAGE)
    expect(first).toContain(`page 1 of ${inboxPages(occ.length)}`)
    expect(first).toContain('More: /cockpit alerts 2')
    const last = inboxText(occ, 99, 5000, true)
    expect(last).toContain(`page ${inboxPages(occ.length)} of ${inboxPages(occ.length)}`)
    expect(new Set([...ids(first), ...ids(inboxText(occ, 2, 5000, true)), ...ids(inboxText(occ, 3, 5000, true))]).size).toBe(occ.length)
  })
  test('the text carries no key, task identity or free text, never claims attention or a connection, and says alerts are off when they are', () => {
    const k = K('SECRET-UID@123', 'security-failure', 'SECURITY')
    const text = inboxText(occurrencesOf(written(rec(k, { kind: 'security-failure', channel: 'terminal_bell' })), open([k, 'security-failure'])), 1, 2_000_000, false)
    expect(text).not.toContain('SECRET-UID')
    expect(text).not.toMatch(NEVER_CLAIMED)
    expect(text).toContain('Alerts are off')
    expect(text).toMatch(/CRITICAL security-failure · task 1 · recorded 1970-01-01 00:00Z/)
    expect(text).toContain('notification SENT via terminal_bell · not acknowledged · condition OPEN now')
  })
  test('nothing recorded says so; a clock behind the record shows no age', () => {
    expect(inboxText([], 1, 0, true)).toContain('Nothing recorded.')
    const occ = occurrencesOf(written(rec('a:run-blocked:task', { at: 9_000_000 })), [])
    expect(inboxText(occ, 1, 1_000, true)).not.toContain('ago')
    expect(inboxText(occ, 1, 9_000_000 + 5 * HOUR, true)).toContain('(5h ago)')
  })
})

describe('acknowledging one occurrence', () => {
  const a = K('u1', 'run-blocked', 'task')
  const b = K('u1', 'security-failure', 'SECURITY')
  const kept = written(rec(a), rec(b, { kind: 'security-failure', at: 1500 }), rec(a, { at: 2000, nth: 1 }))
  const holds = open([a, 'run-blocked'], [b, 'security-failure'])
  const idA = episodesOf(kept)[0]!.id
  const idB = episodesOf(kept)[1]!.id
  test('exactly the selected occurrence is acknowledged: every record of it, and no record of another', () => {
    const r = ackOccurrence(kept, holds, idA)
    expect(r.result).toBe('acked')
    expect(r.alerts.map(x => [x.key === a, x.acked === true])).toEqual([[true, true], [false, false], [true, true]])
    expect(kept.every(x => x.acked === undefined)).toBe(true)
  })
  test('an acknowledged occurrence is not repeated; another one still is', () => {
    const cfg = guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 5 })
    const after = ackOccurrence(kept, holds, idA).alerts
    expect(remind(cfg, EMPTY_GUARD, after, a, 9e9)).toEqual({ send: false, why: 'acknowledged' })
    expect(remind(cfg, EMPTY_GUARD, after, b, 9e9)).toMatchObject({ send: true })
  })
  test('twice is "already", and changes nothing', () => {
    const once = ackOccurrence(kept, holds, idA).alerts
    const r = ackOccurrence(once, holds, idA)
    expect(r.result).toBe('already')
    expect(r.alerts).toEqual(once)
  })
  test('an unknown id and a malformed one are refused and change nothing', () => {
    expect(ackOccurrence(kept, holds, '00000000').result).toBe('unknown')
    for (const bad of ['', 'abc', 'ABCDEF01', idA.toUpperCase(), `${idA}0`, 'zzzzzzzz', '*', 'all', '../x', idA.slice(0, 7)]) {
      const r = ackOccurrence(kept, holds, bad)
      expect(r.result).toBe('malformed')
      expect(r.alerts).toEqual(kept)
    }
  })
  test('an occurrence that no longer holds can be acknowledged too, and the result says it was only the record', () => {
    const r = ackOccurrence(kept, open([b, 'security-failure']), idA)
    expect(r.result).toBe('acked')
    expect(r.occurrence?.state).toBe('ended')
  })
  test('an occurrence that was resolved and came back: acknowledging the old one leaves the new one unacknowledged', () => {
    const k2 = written(rec(a), resolved(a, { at: 2000 }), rec(a, { at: 3000 }))
    const [old, now] = episodesOf(k2)
    const r = ackOccurrence(k2, open([a, 'run-blocked']), old!.id)
    expect(occurrencesOf(r.alerts, open([a, 'run-blocked'])).map(o => [o.id === now!.id, o.acked])).toEqual([[false, true], [true, false]])
  })
  test('a deferred or held-back occurrence the person acknowledged is not announced afterwards', () => {
    const d = written(rec(a, { outcome: 'deferred', channel: null, attempts: 0, why: 'quiet' }))
    expect(isSettledQuietly(d, a)).toBe(false)
    expect(isSettledQuietly(ackOccurrence(d, holds, idA).alerts, a)).toBe(true)
    const t = written(rec(a, { outcome: 'throttled', channel: null, attempts: 0, why: 'budget' }))
    expect(isSettledQuietly(ackOccurrence(t, holds, episodesOf(t)[0]!.id).alerts, a)).toBe(true)
    // a notification that was written ends the matter another way, and a failed one is still retried
    const s = written(rec(a))
    expect(isSettledQuietly(ackOccurrence(s, holds, episodesOf(s)[0]!.id).alerts, a)).toBe(false)
    const f = written(rec(a, { outcome: 'failed', channel: null, why: 'error' }))
    expect(isSettledQuietly(ackOccurrence(f, holds, episodesOf(f)[0]!.id).alerts, a)).toBe(false)
    expect(idB).toMatch(ID_RE)
  })
  test('the acknowledgment count covers a notice being written, by count and never by the clock', () => {
    // a clock that went back past an earlier acknowledgment cannot make a later notice read as acknowledged
    const state = withAck(withAck(EMPTY_GUARD, null), a)
    expect(state.seq).toBe(2)
    expect(state.ackSeq).toBe(1)
  })
})

describe('recurrence and the clock', () => {
  test('a recurrence is a new occurrence for the policy: the same occurrence is never sent twice, a recurring one is', () => {
    const cfg = guardConfigOf({ guardAlerts: true })
    const k = K('u1', 'run-blocked', 'task')
    expect(decide(cfg, EMPTY_GUARD, [rec(k)], k, 9e9)).toMatchObject({ send: false, why: 'duplicate' })
    expect(decide(cfg, EMPTY_GUARD, [rec(k), resolved(k, { at: 2000 })], k, 9e9)).toMatchObject({ send: true })
  })
  test('a clock stepped back makes a reminder wait, and the inbox keeps the order the records were written in', () => {
    const cfg = guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 600 })
    const k = K('u1', 'run-blocked', 'task')
    expect(remind(cfg, EMPTY_GUARD, [rec(k, { at: 9_000_000 })], k, 1_000)).toEqual({ send: false, why: 'waiting' })
    const kept = written(rec('old:run-blocked:task', { at: 9_000_000 }), rec('new:run-blocked:task', { at: 1_000 }))
    expect(inboxOrder(occurrencesOf(kept, [])).map(o => o.key)).toEqual(['new:run-blocked:task', 'old:run-blocked:task'])
  })
  test('a long quiet window owes one reminder, not one per interval missed, however long it is (no timer needed)', () => {
    // the host test of this runs an hour of window on a mock clock; this one covers the 5 hours and 45 minutes the v0.5.6 test used
    const cfg = guardConfigOf({ guardAlerts: true, guardRepeat: true, guardRepeatSec: 600, guardMaxReminders: 3, guardMaxAlerts: 10 })
    const k = K('u1', 'run-blocked', 'task')
    const first = rec(k, { at: 1_000_000 })
    const end = 1_000_000 + 5 * HOUR + 45 * MIN
    expect(remind(cfg, EMPTY_GUARD, [first], k, end - MIN)).toMatchObject({ send: true, nth: 1 })
    const after = [first, rec(k, { at: end, nth: 1 })]
    expect(remind(cfg, { ...EMPTY_GUARD, count: 2, sentAt: end }, after, k, end + 8 * MIN)).toEqual({ send: false, why: 'waiting' })
    expect(remind(cfg, { ...EMPTY_GUARD, count: 2, sentAt: end }, after, k, end + 10 * MIN)).toEqual({ send: true, nth: 2 })
  })
})

describe('the HUD count', () => {
  const pin = { key: 'k', kind: 'security-failure' as const, taskId: 3, level: 'CRITICAL' as const, status: 'sent' as const, acked: false }
  test('nothing recorded and nothing unconfirmed draws nothing; unread history alone draws one plain row', () => {
    expect(pinLine([], false, 'ARMED', 120, 0)).toBeNull()
    expect(pinLine([], false, 'ARMED', 120, 2)).toEqual({ text: 'GUARD: ARMED · 2 unacknowledged in history · /cockpit alerts', level: 'INFO' })
    expect(pinLine([], true, 'ARMED', 200, 1)!.text).toBe('GUARD: ARMED · 1 unacknowledged in history · transport not confirmed · /cockpit alerts')
  })
  test('the count row fits every width down to nothing, and never claims attention', () => {
    for (let width = 0; width <= 120; width++) {
      const text = pinLine([], width % 2 === 0, 'ARMED', width, 3)!.text
      expect(text.length).toBeLessThanOrEqual(width)
      expect(text).not.toMatch(NEVER_CLAIMED)
    }
  })
  test('an open pin wins over the count, and the unconfirmed transport row is what it was', () => {
    expect(pinLine([pin], false, 'SENT', 200, 4)!.level).toBe('CRITICAL')
    expect(pinLine([], true, 'ARMED', 120)).toEqual({ text: 'GUARD: ARMED · transport not confirmed · /cockpit guard test', level: 'INFO' })
    expect(pinsOf([], [])).toEqual([])
  })
})

describe('in a run: the inbox', () => {
  test('lists a blocked run with its id, level, outcome, acknowledgment and that its condition is open', armed(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1)
    expect(await say($, 'alerts')).toContain('Nothing recorded.')
    await block($)
    expect(w.notified.length).toBe(1)
    const text = await say($, 'alerts')
    expect(text).toContain('ALERT INBOX · 1 recorded · 1 open now · 1 unacknowledged · page 1 of 1')
    expect(text).toMatch(/^ {2}[0-9a-f]{8} NORMAL run-blocked · task 1 · recorded .* · notification SENT via kitty · not acknowledged · condition OPEN now$/m)
    expect(text).toContain('OPEN NOW')
    expect(text).not.toMatch(NEVER_CLAIMED)
  })
  test('several conditions at once are listed gravest first; each is acknowledged on its own and the rest stay', armed(), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(31_000)
    await failSecurity($)
    const text = await say($, 'alerts')
    expect(ids(text)).toHaveLength(2)
    expect(text.indexOf('CRITICAL security-failure')).toBeLessThan(text.indexOf('NORMAL run-blocked'))
    const sec = idOf(text, 'security-failure')
    const before = JSON.stringify(task(held))
    const out = await say($, `alerts ack ${sec}`)
    expect(out).toContain('was acknowledged; its condition is still open, and no more reminders will be sent for it')
    expect(out).toContain('gates, reviews, approvals and the verification verdict were not changed')
    expect(JSON.stringify(task(held))).toBe(before)
    const after = await say($, 'alerts')
    expect(after).toMatch(new RegExp(`${sec} CRITICAL security-failure .* · acknowledged · condition OPEN now`))
    expect(after).toMatch(/NORMAL run-blocked .* · not acknowledged · condition OPEN now/)
    expect(after).toContain('2 recorded · 2 open now · 1 unacknowledged')
    // the pin still shows the one that was not acknowledged
    expect(await guardRow($)).toContain('NORMAL run blocked')
  })
  test('/cockpit guard ack still acknowledges everything', armed(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(31_000)
    await failSecurity($)
    await say($, 'guard ack')
    const text = await say($, 'alerts')
    expect(text).toContain('2 recorded · 2 open now · 0 unacknowledged')
    expect(ids(text)).toHaveLength(2)
  })
  test('an acknowledgment is the person\'s alone, and a bad one changes nothing', armed(), async ($, on) => {
    world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    const alerts = JSON.stringify(ledger(held).alerts)
    for (const origin of [{ kind: 'sdk' }, { kind: 'plugin', name: 'x' }, { kind: 'future' }, undefined]) expect(await sayAs($, `alerts ack ${id}`, origin)).toContain('only by a command you type')
    for (const args of ['alerts ack', 'alerts ack ' + id + ' extra', 'alerts ack ZZ', 'alerts ack 00000000', 'alerts ack ' + id.replace(/[0-9a-f]/g, 'g'), 'alerts ack *', 'alerts ack all']) {
      const out = await say($, args)
      expect(out).toMatch(/Usage:|8 characters|no recorded alert/)
    }
    expect(JSON.stringify(ledger(held).alerts)).toBe(alerts)
    expect(await say($, 'alerts ack 00000000')).toContain('may have expired from the bounded history')
  })
  test('acknowledging a condition that has already cleared says so, and only marks the record', armed(), async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    const id = idOf(await say($, 'alerts'), 'security-failure')
    await passSecurity($)
    const out = await say($, `alerts ack ${id}`)
    expect(out).toContain('its condition no longer holds, so this only marks the record')
    expect(await say($, `alerts ack ${id}`)).toContain('was already acknowledged')
  })
  test('a cleared condition moves to history, shows as unread on the HUD until acknowledged, and a recurrence is told again as its own occurrence', armed(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    const first = idOf(await say($, 'alerts'), 'run-blocked')
    await unblock($)
    await progress($, { action: 'status' })
    const history = await say($, 'alerts')
    expect(history).toContain('HISTORY (recorded earlier; the condition no longer holds)')
    expect(history).toContain('condition no longer open (recorded resolved)')
    expect(await guardRow($)).toContain('GUARD: ARMED · 1 unacknowledged in history')
    expect(await guardRow($, 400)).toContain('· /cockpit alerts')
    await w.clock.advance(31_000)
    await block($)
    expect(w.notified.length).toBe(2)
    const both = await say($, 'alerts')
    expect(ids(both)).toHaveLength(2)
    expect(ids(both)).toContain(first)
    expect(new Set(ids(both)).size).toBe(2)
  })
  test('with persistent alerts off the recurrence is told again too (v0.5.6 left it as one occurrence)', armed({ guardRepeat: false }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await passSecurity($); await progress($, { action: 'status' })
    await w.clock.advance(31_000)
    await failSecurity($)
    expect(w.notified.length).toBe(2)
    expect((ledger(held).alerts ?? []).map(a => a.outcome)).toEqual(['sent', 'resolved', 'sent'])
  })
  test('a recurrence is still bounded by the cooldown: it is held back, recorded, and pinned', armed({ guardCooldownSec: 600 }), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    await passSecurity($); await progress($, { action: 'status' })
    await failSecurity($)
    expect(w.notified.length).toBe(1)
    expect(await say($, 'alerts')).toContain('HELD BACK, cooldown or budget')
    expect(await guardRow($)).toContain('CRITICAL')
  })
  test('a reset task and a new one with the same number are different occurrences', armed(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    const old = idOf(await say($, 'alerts'), 'run-blocked')
    await command($, 'reset')
    await w.clock.advance(31_000)
    await planAndComplete($, 1); await block($)
    const text = await say($, 'alerts')
    expect(ids(text)).toHaveLength(2)
    expect(ids(text)).toContain(old)
    expect(text.match(/task 1 /g)).toHaveLength(2)
    expect(text).toContain('condition no longer open (recorded resolved)')
    expect(text).toContain('condition OPEN now')
    // acknowledging the old one leaves the new one pinned
    await say($, `alerts ack ${old}`)
    expect(await guardRow($)).toContain('NORMAL run blocked')
  })
  test('with persistent alerts on, an acknowledged occurrence gets no more reminders and an unacknowledged one still does', armed({ guardRepeat: true, guardRepeatSec: 60, guardMaxReminders: 3 }), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(31_000)
    await failSecurity($)
    expect(w.notified.length).toBe(2)
    const sec = idOf(await say($, 'alerts'), 'security-failure')
    await say($, `alerts ack ${sec}`)
    await w.clock.advance(5 * MIN)
    const reminders = w.notified.slice(2).map(n => n.text)
    expect(reminders.length).toBeGreaterThan(0)
    expect(reminders.every(t => t.includes('the run is blocked'))).toBe(true)
  })
  test('a notification written while the person acknowledges that occurrence is born acknowledged', armed({ guardRepeat: true }), async ($, on) => {
    const w = world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 1)
    // the occurrence has to exist to be named, so the acknowledgment races the first notice of a second condition's reminder
    await block($)
    const id = idOf(await say($, 'alerts'), 'run-blocked')
    w.duringNotify = () => command($, `alerts ack ${id}`)
    await w.clock.advance(15 * MIN + 60_000)
    expect((ledger(held).alerts ?? []).filter(a => a.nth !== undefined).every(a => a.acked === true)).toBe(true)
  })
  test('alerts off: the history is shown, with a note, and nothing is recorded or sent', { options: { guardAlerts: false } }, async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await say($, 'alerts')).toContain('Nothing recorded.')
    expect(await say($, 'alerts')).toContain('Alerts are off')
    expect(w.notified).toEqual([])
  })
  test('a page beyond the end is clamped, and a malformed page is a usage line', armed(), async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(await say($, 'alerts 9')).toContain('page 1 of 1')
    for (const bad of ['alerts 0', 'alerts x', 'alerts 1 2', 'alerts -1']) expect(await say($, bad)).toContain('Usage: /cockpit alerts')
  })
  test('the pin and the count are two states of one row, and a narrow band keeps the symbol', armed(), async ($, on) => {
    world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    for (const columns of [200, 80, 40, 24, 12]) {
      const row = (await guardRow($, columns))!
      expect(row.length).toBeLessThanOrEqual(columns)
    }
    await say($, 'guard ack')
    await passSecurity($); await progress($, { action: 'status' })
    expect(await guardRow($, 120)).toBeDefined()
  })
})

describe('recovery: restart, reload and project switch', () => {
  const q = { options: { guardAlerts: true, guardCooldownSec: 30, guardMaxAlerts: 20 } }
  test('the Ledger and the project history both keep the alerts, tied to a hash of the directory and never its path', q, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const l = ledger(held)
    expect(l.alertsProject).toMatch(/^[0-9a-f]{12}$/)
    const stored = lastStored(w, KEEP)
    expect(stored.v).toBe(1)
    expect(Object.keys(stored.projects)).toEqual([l.alertsProject])
    expect(JSON.stringify(stored)).not.toContain('/work/example')
    expect(stored.projects[l.alertsProject!]).toEqual(l.alerts)
  })
  test('a new session of the same project finds the history, and sends nothing for it', q, async ($, on) => {
    // a new session: another id, an empty Ledger, no task, the same project and store
    const w = world(on, {}, { [KEEP]: { v: 1, projects: { [await projectHash('/work/example')]: written(rec('9@9:run-blocked:task', { at: 5000 })) } } }); hostState(on, {}); session(on, 's2')
    await start($)
    const text = await say($, 'alerts')
    expect(ids(text)).toHaveLength(1)
    expect(text).toContain('HISTORY (recorded earlier; the condition no longer holds)')
    expect(text).toContain('condition no longer open (task replaced or gone)')
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
  })
  test('the same task carried into a new session is not told again, and its acknowledgment is kept', q, async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { [KEEP]: { v: 1, projects: { [await projectHash('/work/example')]: written({ ...rec(keyOfTask(t), { at: 1 }), acked: true }) } } }); hostState(on, { task: t }); session(on, 's9')
    await start($)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
    expect(await say($, 'alerts')).toMatch(/NORMAL run-blocked .* · acknowledged · condition OPEN now/)
  })
  test('another project does not see this project\'s history', q, async ($, on) => {
    const w = world(on, { cwd: '/work/another' }, { [KEEP]: { v: 1, projects: { [await projectHash('/work/example')]: written(rec('9@9:run-blocked:task', { at: 5000 })) } } }); hostState(on, {}); session(on, 's2')
    await start($)
    expect(await say($, 'alerts')).toContain('Nothing recorded.')
    expect(w.notified).toEqual([])
  })
  test('a project\'s history is written back as it was found, plus what the session recorded', q, async ($, on) => {
    const earlier = written(rec('9@9:run-blocked:task', { at: 5000 }))
    const w = world(on, {}, { [KEEP]: { v: 1, projects: { [await projectHash('/work/example')]: earlier } } }); const held = hostState(on, {}); session(on, 's2')
    await start($); await planAndComplete($, 1); await block($)
    const l = ledger(held)
    expect(l.alerts!.slice(0, 1)).toEqual(earlier)
    expect(lastStored(w, KEEP).projects[l.alertsProject!]).toEqual(l.alerts)
  })
  test('history of several projects is kept side by side, bounded to four, the oldest forgotten first', q, async ($, on) => {
    const many: Record<string, AlertRecord[]> = {}
    for (let i = 0; i < 6; i++) many[`${i}`.repeat(12)] = written(rec(`p${i}:run-blocked:task`))
    const w = world(on, {}, { [KEEP]: { v: 1, projects: many } }); hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    const stored = lastStored(w, KEEP)
    expect(Object.keys(stored.projects).length).toBeLessThanOrEqual(4)
    expect(Object.keys(stored.projects)).not.toContain('000000000000')
  })
  const DAMAGED: [string, unknown][] = [['text', 'text'], ['a number', 7], ['null', null], ['an array', []], ['another version', { v: 2, projects: {} }], ['projects not an object', { v: 1, projects: 'x' }], ['bad names and records', { v: 1, projects: { '../etc': [rec('k')], abcdefabcdef: [{ key: 7 }, null, { ...rec('k'), outcome: 'postponed' }] } }]]
  for (const [name, bad] of DAMAGED) {
    test(`a damaged project history (${name}) is ignored: nothing is believed, nothing throws`, q, async ($, on) => {
      const w = world(on, {}, { [KEEP]: bad }); hostState(on, {}); session(on)
      await start($)
      expect(await say($, 'alerts')).toContain('Nothing recorded.')
      expect(w.notified).toEqual([])
    })
  }
  test('records from v0.5.6, which have no id and no project, are listed with derived ids and acknowledged by them', q, async ($, on) => {
    const t = blockedTask()
    const w = world(on, {}, { 'ledger:s1': { ...emptyLedger('s1'), alerts: [rec(keyOfTask(t), { at: 1 }), rec('9@9:security-failure:SECURITY', { kind: 'security-failure', taskId: 9, at: 2 })] } })
    session(on, 's1')
    const held = hostState(on, { task: t })
    await start($)
    const text = await say($, 'alerts')
    expect(ids(text)).toHaveLength(2)
    const id = idOf(text, 'run-blocked')
    expect(id).not.toBe('none')
    expect(ledger(held).alertsProject).toMatch(/^[0-9a-f]{12}$/)
    await say($, `alerts ack ${id}`)
    // the derived id is the one the occurrence keeps when it is written to again
    await w.clock.advance(HOUR)
    expect(idOf(await say($, 'alerts'), 'run-blocked')).toBe(id)
    expect(w.notified).toEqual([])
  })
  test('a hot reload (the session starts again) neither duplicates records nor sends again', q, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1); await block($)
    await start($); await start($)
    await w.clock.advance(HOUR)
    expect(w.notified.length).toBe(1)
    expect((ledger(held).alerts ?? []).filter(a => a.outcome === 'sent')).toHaveLength(1)
    expect(ids(await say($, 'alerts'))).toHaveLength(1)
  })
  test('stored records with the wrong shape, and a Ledger migration, keep only what is well formed', q, async ($, on) => {
    const good = rec('k:run-blocked:task')
    const l = migrateLedger({ ...emptyLedger('s1'), alerts: [good, { ...good, id: 'BAD' }, { key: 1 }, null] as never })
    expect(l.alerts).toEqual([good])
  })
  test('the Ledger and the history stay within their caps however many alerts are raised', q, async ($, on) => {
    const w = world(on); const held = hostState(on, {}); session(on)
    await start($); await planAndComplete($, 1)
    for (let i = 0; i < 40; i++) {
      await failSecurity($); await passSecurity($); await progress($, { action: 'status' })
      await w.clock.advance(31_000)
    }
    expect((ledger(held).alerts ?? []).length).toBeLessThanOrEqual(ALERT_CAP)
    const stored = lastStored(w, KEEP)
    expect(stored.projects[ledger(held).alertsProject!].length).toBeLessThanOrEqual(ALERT_CAP)
    expect(JSON.stringify(stored).length).toBeLessThan(40_000)
    expect(ids(await say($, 'alerts')).length).toBeLessThanOrEqual(INBOX_PAGE)
  })
})

describe('quiet hours and the inbox', () => {
  const quietly = (extra: Record<string, unknown> = {}) => ({ options: { guardAlerts: true, guardCooldownSec: 30, guardQuietHours: '23:00-00:30', guardQuietTimezone: 'UTC', ...extra } })
  test('a deferred alert is listed as deferred and open; acknowledging it means it is not announced when the window ends', quietly(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    expect(w.notified).toEqual([])
    const text = await say($, 'alerts')
    expect(text).toMatch(/NORMAL run-blocked · task 1 · recorded .* · DEFERRED, quiet hours · not acknowledged · condition OPEN now/)
    await say($, `alerts ack ${idOf(text, 'run-blocked')}`)
    await w.clock.advance(HOUR)
    expect(w.notified).toEqual([])
  })
  test('a critical alert in the window is sent and stays on the HUD until it is acknowledged or resolved', quietly(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await failSecurity($)
    expect(w.notified.length).toBe(1)
    await w.clock.advance(HOUR)
    expect(await guardRow($)).toContain('CRITICAL security check failed')
    await say($, `alerts ack ${idOf(await say($, 'alerts'), 'security-failure')}`)
    expect(await guardRow($)).not.toContain('▲')
  })
  test('after the window ends one alert is told and the inbox then reads SENT; nothing is replayed', quietly(), async ($, on) => {
    const w = world(on); hostState(on, {})
    await start($); await planAndComplete($, 1); await block($)
    await w.clock.advance(HOUR)
    expect(w.notified.length).toBe(1)
    expect(await say($, 'alerts')).toContain('notification SENT via kitty')
    await w.clock.advance(6 * HOUR)
    expect(w.notified.length).toBe(1)
  })
})

describe('no verdict moved', () => {
  test('listing and acknowledging change no gate, hold, review, approval or percentage', armed({ guardRepeat: true }), async ($, on) => {
    world(on); const held = hostState(on, {})
    await start($); await planAndComplete($, 2); await failSecurity($)
    const before = JSON.stringify(task(held))
    const status = await progress($, { action: 'status' })
    const id = idOf(await say($, 'alerts'), 'security-failure')
    await say($, 'alerts 1'); await say($, `alerts ack ${id}`); await say($, `alerts ack ${id}`)
    expect(JSON.stringify(task(held))).toBe(before)
    expect(await progress($, { action: 'status' })).toBe(status)
  })
})
