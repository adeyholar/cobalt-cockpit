// The state and the pure parts of telemetry's disk side (see telemetry.ts for
// what is kept and why). The host follows `$` only into functions declared in
// the module that holds the hooks, so the calls that touch the disk are in
// register.tsx; what they share with it is here. Every failure is counted
// rather than raised: telemetry never breaks a session, a hook or a command,
// and /cockpit stats and /cockpit doctor say when the record is incomplete.

import { aggregate, isTelemetryFile, monthKey, monthOfFile, parseLines, DAY_MS } from './telemetry'
import type { Stats, TEvent } from './telemetry'

export type Health = { enabled: boolean; dir: string | null; writes: number; failures: number; permissions: 'unchecked' | 'verified' | 'unverified'; shed: number }
export const health: Health = { enabled: true, dir: null, writes: 0, failures: 0, permissions: 'unchecked', shed: 0 }
/** This process's own segment: the only file it writes, and the only writer of it. */
export const segment: { sid: string | null; n: number; month: string | null; lines: string[]; bytes: number; verified: Set<string> } = { sid: null, n: 0, month: null, lines: [], bytes: 0, verified: new Set() }
/** Tunable only so a test can fill a segment without writing 64 KiB. */
export const limits = { segmentCap: 64 * 1024 }
export const prepared: { dir: string | null } = { dir: null }
export const queue: { tail: Promise<void> } = { tail: Promise.resolve() }

export const setEnabled = (on: boolean): void => { health.enabled = on }
export const healthOf = (): Readonly<Health> => ({ ...health })
/** For tests: forget what this process prepared, as a new process would. */
export const resetStore = (): void => { queue.tail = Promise.resolve(); prepared.dir = null; Object.assign(segment, { sid: null, n: 0, month: null, lines: [], bytes: 0, verified: new Set() }); Object.assign(health, { enabled: true, dir: null, writes: 0, failures: 0, permissions: 'unchecked', shed: 0 }) }

/** A random 8-hex id for this process's segments; the host's web crypto when it has one, the clock otherwise. */
export const newSid = (at: number): string => {
  try {
    const bytes = new Uint8Array(4)
    globalThis.crypto.getRandomValues(bytes)

    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch { return (Math.abs(Math.floor(at * 2654435761)) % 0xffffffff).toString(16).padStart(8, '0') }
}

/** The telemetry directory for these environment values, or null when no absolute state or home directory is known. */
export const dirFor = (state: string | undefined, home: string | undefined): string | null => {
  if (state !== undefined && state.startsWith('/')) return `${state.replace(/\/+$/, '')}/cobalt-cockpit/telemetry`

  return home !== undefined && home.startsWith('/') ? `${home.replace(/\/+$/, '')}/.local/state/cobalt-cockpit/telemetry` : null
}

/** The files a window needs, oldest first. */
export const filesFor = (names: readonly string[], now: number, win: { days: number | null }): string[] => {
  const from = win.days === null ? '' : monthKey(now - win.days * DAY_MS)

  return names.filter(n => isTelemetryFile(n) && monthOfFile(n) >= from).sort()
}

/** Folds the texts of the files (null: unreadable) into statistics. */
export const gather = (texts: readonly (string | null)[], now: number, win: { label: string; days: number | null }): Stats & { unreadableFiles: number } => {
  const events: TEvent[] = []
  let corrupt = 0
  let unreadable = 0
  for (const text of texts) {
    if (text === null) { unreadable++; continue }
    const parsed = parseLines(text)
    events.push(...parsed.events); corrupt += parsed.corrupt
  }

  return { ...aggregate(events, corrupt, now, win), unreadableFiles: unreadable }
}
