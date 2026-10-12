// Quiet hours (v0.5.6, `guardQuietHours`, off by default): a daily window in which an alert is held back, not lost.
//
// The window is wall-clock time in one named zone, so it follows that zone's daylight-saving changes: a window that
// spans a skipped hour is that much shorter on that night, one that spans a repeated hour that much longer. Nothing is
// computed ahead: each look asks what time it is there now, so a clock that jumps is simply read again.
//
// The confirmed channel on a remote terminal is the bell, and there the notification IS the sound. So a held-back
// alert is not sent quietly: nothing is written to the terminal at all, which is the only silence this host can
// promise. An alert the operator chose to keep during the window is sent as it always is, and is reported as audible
// on a bell channel and as unknown on the others, never as silent.
//
// A window, a zone or a mode that cannot be read turns quiet hours off, with the reason shown: a setting that was not
// understood must never be the reason an alert went unsent.

/** What happens to an alert of one class during the window: held until it ends, or sent as usual. */
export type QuietMode = 'defer' | 'notify'
export type QuietConfig = {
  /** A window was asked for (the option is not empty). */
  asked: boolean
  /** Asked for and every setting was understood: only then is anything ever held back. */
  on: boolean
  /** Minutes after midnight, in the zone. */
  start: number
  end: number
  zone: string
  /** Whether the zone was chosen in the options or is this machine's own. */
  zoneFrom: 'option' | 'machine'
  ordinary: QuietMode
  critical: QuietMode
  /** Why quiet hours are not in force although asked for. Closed sentences; no setting's value is repeated. */
  problems: string[]
}

export const QUIET_OFF: QuietConfig = { asked: false, on: false, start: 0, end: 0, zone: 'UTC', zoneFrom: 'machine', ordinary: 'defer', critical: 'notify', problems: [] }

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
/** `HH:MM` on a 24-hour clock as minutes after midnight, or null. */
export const minutesOf = (text: string): number | null => {
  const m = TIME.exec(text.trim())

  return m === null ? null : Number(m[1]) * 60 + Number(m[2])
}
export const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** The wall-clock minute of the day in a zone, or null when the zone or the moment cannot be read. */
export const localMinutes = (now: number, zone: string): number | null => {
  if (!Number.isFinite(now)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
    const hour = Number(parts.find(p => p.type === 'hour')?.value)
    const minute = Number(parts.find(p => p.type === 'minute')?.value)

    return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null
  } catch { return null }
}
export const isZone = (zone: string): boolean => zone !== '' && zone.length <= 64 && localMinutes(0, zone) !== null

/** This machine's own zone as its runtime names it; UTC when it names none. */
export const machineZone = (): string => {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone

    return typeof zone === 'string' && isZone(zone) ? zone : 'UTC'
  } catch { return 'UTC' }
}

const modeOf = (x: unknown, d: QuietMode): QuietMode | null => (x === undefined || x === null || x === '' ? d : x === 'defer' || x === 'notify' ? x : null)

/**
 * The quiet-hours settings as read. `guardQuietHours` is `HH:MM-HH:MM` (empty: off), `guardQuietTimezone` an IANA zone
 * (empty: this machine's), and the two modes say what each class of alert does in the window. `fallbackZone` is the
 * machine's zone, handed in so the reading is the same wherever it is tested.
 */
export const quietConfigOf = (options: Readonly<Record<string, unknown>>, fallbackZone: string): QuietConfig => {
  const window = typeof options['guardQuietHours'] === 'string' ? options['guardQuietHours'].trim() : ''
  const asked = options['guardAlerts'] === true && (window !== '' || (options['guardQuietHours'] !== undefined && options['guardQuietHours'] !== null && typeof options['guardQuietHours'] !== 'string'))
  if (!asked) return QUIET_OFF
  const problems: string[] = []
  const ends = window.split('-')
  const start = ends.length === 2 ? minutesOf(ends[0] as string) : null
  const end = ends.length === 2 ? minutesOf(ends[1] as string) : null
  if (start === null || end === null) problems.push('guardQuietHours is not a window like 22:00-07:00 (24-hour HH:MM-HH:MM)')
  else if (start === end) problems.push('guardQuietHours starts and ends at the same minute, which is no window')
  const named = typeof options['guardQuietTimezone'] === 'string' ? options['guardQuietTimezone'].trim() : ''
  if (options['guardQuietTimezone'] !== undefined && options['guardQuietTimezone'] !== null && typeof options['guardQuietTimezone'] !== 'string') problems.push('guardQuietTimezone is not a zone name')
  else if (named !== '' && !isZone(named)) problems.push('guardQuietTimezone is not a time zone this machine knows (use an IANA name such as Europe/Berlin)')
  const usable = isZone(fallbackZone) ? fallbackZone : 'UTC'
  const ordinary = modeOf(options['guardQuietOrdinary'], 'defer')
  const critical = modeOf(options['guardQuietCritical'], 'notify')
  if (ordinary === null) problems.push('guardQuietOrdinary is neither defer nor notify')
  if (critical === null) problems.push('guardQuietCritical is neither defer nor notify')

  return { asked: true, on: problems.length === 0, start: start ?? 0, end: end ?? 0, zone: named !== '' && isZone(named) ? named : usable, zoneFrom: named !== '' && isZone(named) ? 'option' : 'machine', ordinary: ordinary ?? 'defer', critical: critical ?? 'notify', problems }
}

/** Whether a minute of the day lies in the window. The start is inside, the end is not; a window may cross midnight. */
export const inWindow = (minute: number, start: number, end: number): boolean => (start < end ? minute >= start && minute < end : start > end ? minute >= start || minute < end : false)

/** Whether the window is open now. False whenever quiet hours are off, were not understood, or the time cannot be read. */
export const isQuiet = (q: QuietConfig, now: number): boolean => {
  if (!q.on) return false
  const minute = localMinutes(now, q.zone)

  return minute !== null && inWindow(minute, q.start, q.end)
}

/** Whether an alert of this class is held back right now. */
export const isHeld = (q: QuietConfig, critical: boolean, now: number): boolean => isQuiet(q, now) && (critical ? q.critical : q.ordinary) === 'defer'

/** What the channel last written to can promise about sound. Never "silent": only an alert that is not sent is that. */
export const audibleText = (channel: string | null): string =>
  channel === 'terminal_bell' ? 'AUDIBLE: your channel is the terminal bell, so the notification itself rings'
    : channel === 'iterm2_with_bell' ? 'AUDIBLE: your channel rings the bell with the notification'
      : channel === null ? 'may be audible: no notification was written in this session yet, so the channel is not known'
        : `sent through ${channel}; whether that makes a sound is decided by your terminal and desktop, which Cockpit cannot see`

/** The quiet-hours status, for `/cockpit guard` and `/cockpit doctor`. Closed words, the window, the zone and the time there. */
export const quietLines = (q: QuietConfig, now: number, channel: string | null, isSsh: boolean): string[] => {
  if (!q.asked) return ['Quiet hours: off · set guardQuietHours to a window such as 22:00-07:00 to hold alerts back overnight.']
  if (!q.on) return ['Quiet hours: NOT IN FORCE · the settings were not understood, so every alert is sent as usual.', ...q.problems.map(p => `  WARN ${p}`)]
  const minute = localMinutes(now, q.zone)
  const quiet = minute !== null && inWindow(minute, q.start, q.end)
  const zone = `${q.zone} (${q.zoneFrom === 'option' ? 'guardQuietTimezone' : 'this machine\'s zone; set guardQuietTimezone to choose'})`
  const lines = [`Quiet hours: ${clockOf(q.start)}-${clockOf(q.end)} ${zone} · ${minute === null ? 'the time there cannot be read, so the window is treated as closed' : `now ${clockOf(minute)} there`} · ${quiet ? 'ACTIVE' : 'not active'}`]
  const say = (mode: QuietMode): string => (mode === 'defer'
    ? `DEFERRED until ${clockOf(q.end)}: nothing is written to your terminal, so nothing rings; they stay on the HUD and here, and one notification follows if still open`
    : `still sent · ${audibleText(channel)}`)
  lines.push(`  in the window, ordinary alerts: ${say(q.ordinary)}`)
  lines.push(`  in the window, critical alerts (security failure): ${say(q.critical)}`)
  lines.push('  in the window the separate alert sound is not played. The window follows the wall clock in that zone, daylight-saving changes included.')
  if (q.zoneFrom === 'machine' && isSsh) lines.push('  WARN the window uses the zone of the machine Claude Code runs on, and this is an SSH session: if you are in another zone, set guardQuietTimezone.')

  return lines
}
