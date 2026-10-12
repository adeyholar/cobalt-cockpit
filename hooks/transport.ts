// Verified notification transport (v0.5.5): whether an alert can really reach the person at this terminal.
//
// A test is one explicitly labelled notification the person asks for. It is not an alert: it is kept apart from the
// alert records, spends none of their budget or cooldown, and reads or changes no gate, hold, review or approval.
//
// Four states, and no more: NOT TESTED, ATTEMPTED (a send was made and the host did not report writing it), SENT (the
// host reported the channel it wrote to) and USER CONFIRMED (the person typed that they saw or heard it). Nothing is
// ever called DELIVERED. A confirmation is what a person said, in this session, soon after the test; it is not proof.
//
// The notification carries a short code that is shown nowhere else, so typing it back means the text was read. The
// code is required, except on a channel that only rings a bell and shows no text; that confirmation is kept as one
// made without the code. A confirmation also ages: after twelve hours it no longer speaks for the transport.
//
// Nothing here carries a prompt, code, path, command or secret: the text is a closed sentence and a random code.

import type { Why } from './alerts'

/** How this process was reached, as far as its own environment says: an SSH session, or not. A reconnect cannot be seen. */
export type Link = 'local' | 'ssh'
/** The cue, apart from the notification: not asked for, started, a player or the bell exited 0, or nothing played. */
export type SoundState = 'not-requested' | 'pending' | 'sound' | 'bell' | 'none'
export type TransportTest = {
  code: string
  at: number
  session: string
  link: Link
  outcome: 'sent' | 'failed' | 'refused'
  channel: string | null
  why?: Why
  sound: SoundState
  seenAt?: number
  /** Whether the person typed the code the notification showed, or confirmed without one. */
  seenBy?: 'code' | 'no-code'
}
export type Transport = { tests: TransportTest[] }
export const EMPTY_TRANSPORT: Transport = { tests: [] }

export const TEST_COOLDOWN_MS = 30_000
export const TEST_MAX = 6
export const TEST_KEEP = 8
export const SEEN_WINDOW_MS = 600_000
/** How long a confirmation speaks for the transport: a terminal, a connection or a desk can change without this process seeing it. */
export const CONFIRM_TTL_MS = 12 * 3_600_000
/** After this long a sound still marked as started is reported as unknown: its player is gone or the module was reloaded. */
export const SOUND_PENDING_MS = 60_000
export type TransportStatus = 'NOT TESTED' | 'ATTEMPTED' | 'SENT' | 'USER CONFIRMED'

// no 0/O, 1/I/L: the code is read off a popup and typed
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_RE = /^[A-HJKMNP-Z2-9]{4}$/
/** A four-character code from four bytes; a missing or unusable byte counts as 0. */
export const codeOf = (bytes: readonly number[]): string => [0, 1, 2, 3].map(i => { const b = bytes[i]; return ALPHABET[typeof b === 'number' && Number.isFinite(b) ? Math.abs(Math.trunc(b)) % ALPHABET.length : 0] }).join('')

export const linkOf = (sshConnection: string | undefined, sshTty: string | undefined): Link => ((sshConnection ?? '') !== '' || (sshTty ?? '') !== '' ? 'ssh' : 'local')
export const isBellOnly = (channel: string | null): boolean => channel === 'terminal_bell'

/** The whole text of a test notification: a closed sentence and the code. */
export const testMessage = (code: string): string => `Cobalt Guard TEST ${code}: this is a test, not an incident. Nothing is wrong and nothing was changed. If you see this, type /cockpit guard seen ${code}`

const OUTCOMES: readonly string[] = ['sent', 'failed', 'refused']
const SOUNDS: readonly string[] = ['not-requested', 'pending', 'sound', 'bell', 'none']
const WHYS: readonly string[] = ['disabled', 'no-channel', 'no-surface', 'refused', 'error', 'cooldown', 'budget']
const isTest = (x: unknown): x is TransportTest => {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>

  return typeof r['code'] === 'string' && CODE_RE.test(r['code']) && typeof r['at'] === 'number' && Number.isFinite(r['at']) && typeof r['session'] === 'string' && r['session'] !== '' && r['session'].length <= 128
    && (r['link'] === 'local' || r['link'] === 'ssh') && OUTCOMES.includes(r['outcome'] as string) && (r['channel'] === null || (typeof r['channel'] === 'string' && r['channel'].length <= 32))
    && (r['why'] === undefined || WHYS.includes(r['why'] as string)) && SOUNDS.includes(r['sound'] as string)
    && (r['seenAt'] === undefined || (typeof r['seenAt'] === 'number' && Number.isFinite(r['seenAt']))) && (r['seenBy'] === undefined || r['seenBy'] === 'code' || r['seenBy'] === 'no-code')
    && (r['seenAt'] === undefined) === (r['seenBy'] === undefined)
}
/** What is held, as this build wrote it. A malformed record is dropped, never believed. */
export const validTransport = (x: unknown): Transport => {
  const tests = x !== null && typeof x === 'object' && Array.isArray((x as { tests?: unknown }).tests) ? (x as { tests: unknown[] }).tests.filter(isTest).slice(-TEST_KEEP) : []

  return { tests }
}

/** The tests of this session, oldest first: another session's test is never counted, shown as current or confirmed. */
export const mine = (t: Transport, session: string): TransportTest[] => (session === '' ? [] : t.tests.filter(a => a.session === session))

export type MayTest = { ok: true } | { ok: false; why: 'cooldown'; waitSec: number } | { ok: false; why: 'budget' } | { ok: false; why: 'unknown-session' }
/** Whether a test may be sent now: a limit of its own, apart from the alerts' budget and cooldown. */
export const mayTest = (t: Transport, session: string, now: number): MayTest => {
  if (session === '') return { ok: false, why: 'unknown-session' }
  const own = mine(t, session)
  if (own.length >= TEST_MAX) return { ok: false, why: 'budget' }
  const last = own.at(-1)
  // a clock that went backwards waits rather than fires
  if (last !== undefined && !(now - last.at >= TEST_COOLDOWN_MS)) {
    const wait = Math.ceil((TEST_COOLDOWN_MS - (now - last.at)) / 1000)

    return { ok: false, why: 'cooldown', waitSec: Number.isFinite(wait) ? Math.max(1, Math.min(TEST_COOLDOWN_MS / 1000, wait)) : TEST_COOLDOWN_MS / 1000 }
  }

  return { ok: true }
}

export const added = (t: Transport, test: TransportTest): Transport => ({ tests: [...t.tests, test].slice(-TEST_KEEP) })

export type Confirmed = 'confirmed' | 'already' | 'none' | 'not-sent' | 'expired' | 'other-link' | 'wrong-code' | 'bad-code' | 'needs-code'
/**
 * The person says they saw or heard the latest test of this session. Refused, and nothing changed, when there is none,
 * when the host never reported writing it, when it was already confirmed, when it is older than the window, when the
 * connection kind changed since, when a code was typed that is not its code, or when none was typed although the
 * channel shows the text (only a bell-only channel is confirmed without one).
 */
export const confirm = (t: Transport, session: string, link: Link, typed: string, now: number): { transport: Transport; result: Confirmed } => {
  const last = mine(t, session).at(-1)
  if (last === undefined) return { transport: t, result: 'none' }
  if (last.seenAt !== undefined) return { transport: t, result: 'already' }
  if (last.outcome !== 'sent') return { transport: t, result: 'not-sent' }
  if (!(now - last.at >= 0 && now - last.at <= SEEN_WINDOW_MS)) return { transport: t, result: 'expired' }
  if (last.link !== link) return { transport: t, result: 'other-link' }
  const code = typed.trim().toUpperCase()
  if (code !== '' && !CODE_RE.test(code)) return { transport: t, result: 'bad-code' }
  if (code !== '' && code !== last.code) return { transport: t, result: 'wrong-code' }
  if (code === '' && !isBellOnly(last.channel)) return { transport: t, result: 'needs-code' }
  const seen: TransportTest = { ...last, seenAt: now, seenBy: code === '' ? 'no-code' : 'code' }

  return { transport: { tests: t.tests.map(a => (a === last ? seen : a)) }, result: 'confirmed' }
}

/** Whether a confirmed test still speaks for where the person is now: this session, the same kind of connection, and not too long ago. */
const applies = (a: TransportTest, session: string, link: Link, now: number): boolean =>
  session !== '' && a.session === session && a.link === link && a.seenAt !== undefined && now - a.seenAt >= 0 && now - a.seenAt <= CONFIRM_TTL_MS

/** The transport's state for this session, from its latest test. A confirmation of an older test says nothing about a newer one. */
export const statusOf = (t: Transport, session: string, link: Link, now: number): TransportStatus => {
  const last = mine(t, session).at(-1)
  if (last === undefined) return 'NOT TESTED'
  if (applies(last, session, link, now)) return 'USER CONFIRMED'

  return last.outcome === 'sent' ? 'SENT' : 'ATTEMPTED'
}

const ago = (now: number, at: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000))

  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}
const SOUND_TEXT: Record<SoundState, string> = {
  'not-requested': 'sound not requested',
  pending: 'sound started, no player has answered yet',
  sound: 'sound attempted (a player exited 0; not proof it was heard)',
  bell: 'terminal bell attempted (exited 0; not proof it was heard)',
  none: 'sound not played (sounds off, muted, or no player answered)',
}

/** The transport diagnostics, for `/cockpit guard` and `/cockpit doctor`. Closed words, numbers and the host's channel name only; the code is never shown. */
export const transportLines = (t: Transport, session: string, link: Link, now: number, armed: { enabled: boolean; repeat: boolean }): string[] => {
  const status = statusOf(t, session, link, now)
  const own = mine(t, session)
  const last = own.at(-1)
  const lines = [`TRANSPORT: ${status}`]
  if (last === undefined) lines.push('  No test notification was sent in this session. /cockpit guard test sends one; /cockpit guard seen <code> records that you saw it.')
  else {
    const how = last.outcome === 'sent' ? `SENT via ${last.channel ?? 'unknown'} (the host reported writing it; it cannot tell whether it was shown)` : `ATTEMPTED, not sent (${last.outcome}${last.why === undefined ? '' : `: ${last.why}`})`
    lines.push(`  last test: ${how} · ${ago(now, last.at)}`)
    lines.push(`  ${last.sound === 'pending' && !(now - last.at <= SOUND_PENDING_MS) ? 'sound outcome unknown (it was started and no result was recorded)' : SOUND_TEXT[last.sound]}`)
    if (last.outcome === 'sent' && isBellOnly(last.channel)) lines.push('  WARN the channel is the terminal bell only: it rings and shows neither the text nor the code. Confirm with /cockpit guard seen (no code) if you heard it.')
    if (last.outcome !== 'sent' && last.why === 'refused') lines.push('  WARN another hook answered the notification without sending it.')
    if (last.outcome !== 'sent' && last.why === 'no-channel') lines.push('  WARN the host found no terminal notification channel here. Its channels are iTerm2, kitty, Ghostty and the terminal bell; another terminal needs preferredNotifChannel set to terminal_bell in Claude Code to get the bell.')
    if (last.outcome !== 'sent' && last.why === 'disabled') lines.push('  WARN notifications are turned off in Claude Code for this user.')
    if (last.outcome !== 'sent' && last.why === 'no-surface') lines.push('  WARN this session has no terminal to notify (a headless, SDK or desktop run).')
  }
  const seen = [...own].reverse().find(a => a.seenAt !== undefined)
  if (seen === undefined) lines.push('  human confirmation: none in this session')
  else {
    const fits = seen.link !== link ? 'made on a different kind of connection; does not apply now'
      : !applies(seen, session, link, now) ? `older than ${CONFIRM_TTL_MS / 3_600_000}h; no longer counted, test again`
        : link === 'ssh' ? 'applies to this session, unless you reconnected since (that cannot be detected)' : 'applies to this session'
    lines.push(`  human confirmation: ${ago(now, seen.seenAt ?? now)} · ${seen.seenBy === 'code' ? 'the code shown was typed back' : 'confirmed without the code'} · via ${seen.channel ?? 'unknown'} · ${fits}`)
    if (last !== undefined && seen !== last) lines.push('  a newer test has not been confirmed.')
  }
  if (session === '') lines.push('  WARN the session could not be identified, so no test can be tied to it.')
  if (t.tests.some(a => a.session !== session)) lines.push('  an earlier session\'s tests are not counted here.')
  lines.push(`  connection: ${link === 'ssh' ? 'SSH (this process was started in an SSH session). Whether a notification or bell crosses it to your desktop depends on your local terminal; a reconnect cannot be detected, so test again after one.' : 'no SSH session detected for this process.'}`)
  if (armed.enabled && status !== 'USER CONFIRMED') lines.push(`  WARN transport unverified: ${armed.repeat ? 'persistent alerts are' : 'alerts are'} armed, and nobody has confirmed seeing a notification in this session.`)
  lines.push(`  tests used: ${own.length} of ${TEST_MAX} this session, at most one every ${TEST_COOLDOWN_MS / 1000}s; they use none of the alert budget. A confirmation is your statement, not proof of delivery.`)

  return lines
}
