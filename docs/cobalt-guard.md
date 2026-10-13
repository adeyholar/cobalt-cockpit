# Cobalt Guard: owner alerts

> Part of the [Cobalt Cockpit documentation](README.md). This text was moved here from the root README when the README was restructured for v0.6.0; the wording is unchanged unless a sentence says otherwise. Overview: [Cobalt Guard](../README.md#cobalt-guard).

Everything on this page is off by default: `guardAlerts` turns alerts on, `guardRecordOnly` records without telling. The Stop-hook verification guard, which `/cockpit guard` also manages, is described in [implementation-v0.5.2.md](implementation-v0.5.2.md) and in [SECURITY.md](../SECURITY.md).

## Persistent alerts (v0.5.4, opt-in)

With `guardAlerts` and `guardRepeat` both on, an alert whose condition is still open is repeated until you deal with it:

- **Bounded.** One reminder per `guardRepeatSec` for a condition, at most `guardMaxReminders` each, never closer to any other alert than `guardCooldownSec`, and inside the session's `guardMaxAlerts`. The budget's last alert is kept for a condition that has not been told at all. A reminder that failed to send counts as one.
- **Acknowledge.** `/cockpit guard ack` ends the reminders of everything open now. A different condition raised later is still told.
- **Silence.** `/cockpit guard silence` acknowledges and stops all alerts for the session; `/cockpit guard unsilence` lets new conditions be told again. All three are accepted only when typed by a person.
- **Resolved.** When a condition no longer holds (the gate passes, the hold is released, the task is reset or replaced) it is recorded `resolved` without a notification and is not repeated. If it comes back it is told as a new alert.
- **Sound.** `guardSound` tries the existing checkpoint cue with each alert and reminder; the player chain ends with the terminal bell. It stays silent when `sounds` is off or after `/cockpit mute`.
- **One timer.** A single 30-second host timer (`$.clock.every`) exists only while something can still be repeated. It is cancelled on acknowledgment, silence, resolution, exhaustion and session end, and re-armed from the kept records after a reload, so counts carry on instead of starting over. No background process is started.
- **No verdict changes.** An alert, a reminder, an acknowledgment or a silence never changes a gate, a hold, a review, a release approval or the task's percentage.
- **What is claimed.** `sent` means the host reported writing the notification to the channel it names; `sound attempted` or `bell attempted` means a local player exited 0. Neither means you saw or heard it. Desktop popups are whatever your terminal does with the host's notification (the host's channels are kitty, iTerm2 and Ghostty; another terminal gets nothing under the host's automatic setting, or the bell if Claude Code's `preferredNotifChannel` is `terminal_bell`). Cockpit starts no desktop notifier of its own, and on a remote machine whether the notification reaches your local desktop depends on your terminal and connection and is not verified by Cockpit.

## The alert inbox (v0.5.7)

`/cockpit alerts` lists what Cobalt Guard recorded, so you can recover it after stepping away. It reads the same alert records the engine already keeps; it is not a second store.

```
ALERT INBOX · 3 recorded · 2 open now · 2 unacknowledged · page 1 of 1
OPEN NOW (read from the current task)
  3f9a02bc CRITICAL security-failure · task 3 · recorded 2026-10-12 14:03Z (12m ago) · notification SENT via terminal_bell · not acknowledged · condition OPEN now
  71c0de45 NORMAL run-blocked · task 3 · recorded 2026-10-12 13:40Z (35m ago) · DEFERRED, quiet hours · acknowledged · condition OPEN now
HISTORY (recorded earlier; the condition no longer holds)
  a1b2c3d4 HIGH review-hold · task 2 · recorded 2026-10-11 22:10Z (16h ago) · notification SENT via terminal_bell · not acknowledged · condition no longer open (recorded resolved)
```

- **Order.** Open and unacknowledged first, the gravest first; then open and acknowledged; then history, newest first. Eight to a page: `/cockpit alerts 2`.
- **Recorded and current are told apart.** "Recorded" is what Cockpit wrote when it raised the alert, with the clock of this machine. "Condition OPEN now" is read off the task as it is now. History is not re-checked.
- **What a status means.** `SENT` is the host saying it wrote the notification to the channel named, never that you saw it. `NOT SENT`, `DEFERRED, quiet hours`, `HELD BACK, cooldown or budget` and `NOT NOTIFIED` say why nothing was written. An alert nobody acknowledged is "not acknowledged", not "missed". Cockpit does not detect SSH disconnects or reconnects and does not say it did.
- **Acknowledge one.** `/cockpit alerts ack <id>` (the 8-character id in the first column) acknowledges that occurrence only, ends its reminders and, if it was held back and never told, keeps it from being announced after quiet hours end. Other alerts, `/cockpit guard ack` (still everything at once), gates, reviews, approvals and the verdict are untouched. Typed by you only. An id that is malformed, unknown or has expired from the bounded history changes nothing. Acknowledging a condition that has cleared only marks its record.
- **Occurrences.** A condition that clears and holds again is a new occurrence with its own id, told again inside the cooldown, the session budget and the retry cap (v0.5.6 did this only with `guardRepeat` on). A new task with the same number is a different occurrence: ids come from the task's identity, not its number.
- **Recovery.** The records are in the Run Ledger and, per project (a hash of the directory), in a bounded plugin-store key, so a new session in the same project lists them. Nothing is announced again because a session restarted: what was told stays told, and only what was owed (held back by quiet hours) is still owed. The newest 32 records of up to four projects are kept; older ones expire.
- **HUD.** Open conditions are pinned as before. When recorded alerts no longer hold and were never acknowledged, the row says `GUARD: ARMED · 2 unacknowledged in history · /cockpit alerts` until you acknowledge them. It shortens to fit and never animates.

### Shared history, the digest, and notifications off (v0.5.8)

- **What is shared, and how far it can be trusted.** Claude Code's plugin store is one JSON file per plugin. Its `set` and `delete` each take a file lock, read the whole file inside it, change one key and write, so one session's `set` is serialised against another's while the lock holds (a contended `set` can be rejected) and a `set` of one key never changes another. This was read from the host's implementation, not from its documentation. It has no compare-and-set and no transaction: reading a key and then writing it back is two steps another session can fall between. Cockpit therefore keeps an **acknowledgment as a key of its own** (`alert-ack:<project>:<id>`), written once with a fixed value and never read back and rewritten. No other write can undo it, and two sessions acknowledging the same occurrence write the same thing. Other sessions find it with the store's key list and mark their own records. The **records** are kept per project in `alert-history:<project>` by a read, a merge and a write; that part is last-writer-wins, so a record written by one session between another's read and write can be missing from the stored history (never from that session's own Ledger). It cannot take an acknowledgment with it. A session that has not looked since another acknowledged shows the occurrence unacknowledged until its next look: the next tool call, command or 30-second timer, and its reminders stop then.
- **`/cockpit alerts digest`** prints a few lines computed from the records: unacknowledged occurrences by level, how many hold now and how many are history, how many notifications were deferred, not sent or held back, and when the oldest was recorded. It holds no id, key or text from a record, and says what was recorded, never what anyone saw.
- **Persistent Attention (v0.6.2).** The digest ends with a `COBALT GUARD / ATTENTION` section: new incidents, then acknowledged incidents whose condition is observed still open (counts by level and kind, at most five listed), then acknowledged incidents whose condition this session cannot observe (`UNVERIFIED CONDITION STATE`), each incident in one group only. Acknowledging stops reminders and resolves nothing; a condition is OPEN only where this session's own task shows it holding now, never from a stored record, and one raised by another session or an earlier task is UNKNOWN, which is not resolved. The digest stays read-only and sends nothing; an acknowledged incident that stays open is never notified again. The HUD row adds `N acknowledged, still open` and `N unverified`. Details and limits: [implementation-v0.6.2.md](implementation-v0.6.2.md).
- **`guardDigest`** (Cockpit settings, off by default, person-only) shows a one-line count by level when a session starts, if anything is unacknowledged: once per session (a plugin reload does not repeat it; a resumed session gets it again unless it was shown within half an hour), no desktop notification, no model call.
- **Notifications off.** With `guardAlerts` off, `/cockpit alerts`, `/cockpit alerts digest`, acknowledgment and `guardDigest` still work on history recorded earlier. Nothing new is recorded or sent, no notification is turned on, and a user who never had alerts on keeps no history and no project tie.

### Record-only mode and since your last look (v0.5.9)

| `guardAlerts` | `guardRecordOnly` | What happens |
| --- | --- | --- |
| off | off | The default. Nothing new is recorded or told. Earlier history can still be read. |
| on | off | Alerts as always. |
| off | on | **Recording.** Incidents are written down for `/cockpit alerts` and the digest; no notification, sound, bell or reminder is ever sent for them. |
| on | on | Alerts as always, which take precedence: `guardRecordOnly` changes nothing, and the status says so. |

- **What is recorded.** The conditions alerts are raised for (a failed security check, a release NO-GO, exhausted verification, an open review at a stop, a blocked run), once per occurrence, with their level and a stable id, resolved when they stop holding and recorded again as a new occurrence if they recur. The outcome is `recorded` (`RECORDED only, no notification`), never SENT, FAILED or DEFERRED. It uses no cooldown or budget, and silence, the notified kinds and quiet hours govern telling, not recording. A critical incident is pinned on the HUD (`GUARD ▲ CRITICAL … RECORDED, no notification`) until acknowledged or resolved.
- **Switching.** Turning `guardAlerts` on later does not announce an incident that was already recorded; a new one is told as usual. `/cockpit guard test`, which you type, still sends its one labelled test; nothing automatic does.
- **`SINCE LAST LOOK: 1 CRITICAL · 2 HIGH · 3 NORMAL`** heads `/cockpit alerts`, with a second line of active versus history and what became of the notifications (recorded only, SENT, DEFERRED, NOT SENT, held back, acknowledged). It counts the occurrences not shown at your last look, by id. Displaying the inbox marks what it showed; the digest, the start-of-session line and anything that is not you mark nothing; looking never acknowledges. Across two sessions the marker is best effort: a read and a write of one key, which can show an occurrence as new again but never as seen when it was not shown. It counts records, not what anyone read.

## Alert priorities, quiet hours and the pinned alert row (v0.5.6)

With no new option set, alerts are sent exactly as in v0.5.5. Two things differ by default while alerts are on: the HUD's `GUARD` row now adds `transport not confirmed` until you confirm a test in the session and becomes a pin while a raised condition is open, and a condition raised while the session is silenced is recorded so it stays visible.

**Priorities.** Each alert kind has one fixed level. It orders the HUD row and decides what quiet hours treat as critical; it does not reorder sending.

| Level | Kinds |
| --- | --- |
| `CRITICAL` | `security-failure` |
| `HIGH` | `release-no-go`, `verification-exhausted`, `review-hold` |
| `NORMAL` | `run-blocked` |

**Notified kinds.** `guardNotifyKinds` is a comma-separated list of the kinds to notify (empty or `all`: every kind; `none`: only the critical one). `security-failure` cannot be turned off. A kind you leave out is not dropped: it is recorded, pinned on the HUD and listed by `/cockpit guard` as `NOT NOTIFIED, kind off`. A list that is not understood notifies every kind and says so.

**Quiet hours.** `guardQuietHours` is a daily window such as `22:00-07:00` (24-hour, may cross midnight; empty is off). `guardQuietTimezone` names the zone it is read in (an IANA name such as `Europe/Berlin`); left empty it is the zone of the machine Claude Code runs on, which `/cockpit guard` shows together with the time there, and warns about over SSH. The window follows that zone's wall clock, so a night with a daylight-saving change is an hour shorter or longer.

- `guardQuietOrdinary` (`defer` by default) and `guardQuietCritical` (`notify` by default) say what each class does in the window.
- **Deferred** means nothing is written to your terminal: no notification and no sound. This matters because on a bell channel (`terminal_bell`, which is what a terminal such as WezTerm or Konsole gets) the notification *is* the bell, whether or not `guardSound` is on. Cockpit therefore does not "send quietly"; it does not send.
- A deferred alert is recorded as `deferred`, stays pinned on the HUD for the whole window, and is told once after the window ends if it is still open and you have not acknowledged it. Several deferred conditions are told as one notification, not one each. A reminder that came due in the window is one reminder afterwards, not one per interval missed. All of it stays inside the cooldown and the session budget.
- An alert you kept (`notify`) is sent as usual and is reported for what it is: `AUDIBLE` on a bell channel, and "whether that makes a sound is decided by your terminal and desktop" on the others. Cockpit cannot make the host deliver a notification silently and does not claim to. The separate `guardSound` cue is not played in the window.
- A window, a zone or a mode that is not understood turns quiet hours off (`NOT IN FORCE`, with the reason): a setting that was not understood is never the reason an alert went unsent.
- The same 30-second host timer as persistent alerts looks at the clock afresh each time; nothing is scheduled for a moment ahead, so a clock change is simply read again. No daemon, process or network call is added.

**The pinned alert row.** With alerts on, the HUD's one `GUARD` row becomes a pin while a raised condition is still open and not acknowledged:

```
GUARD ▲ CRITICAL security check failed · task 3 · notification SENT, not acknowledged · +1 more
```

It names the gravest condition, the task, what became of its notification (`SENT`, `NOT SENT`, `DEFERRED`, `HELD BACK`, `NOT NOTIFIED`) and how many more are open. It also says `transport not confirmed` while alerts are armed and nobody confirmed a test in this session. It never says a notification was seen. The pin clears when the condition resolves or you run `/cockpit guard ack`; with nothing open and a confirmed transport the row is the plain `GUARD: ARMED` it always was, and with alerts off there is no row. It is one row, shortens to fit the width, is never animated, and is separate from the progress and verification rows.

**Status.** `/cockpit guard` and `/cockpit doctor` show the priorities, which kinds are notified, the quiet-hours window with the zone, the time there and whether it is active, every active condition with its notification state and whether it is acknowledged, how many deferred alerts are owed, and the transport state. The five new settings, like the other alert settings, can be changed only by you in the config menu.

## Verified notification transport (v0.5.5)

An alert is only useful if it reaches you. Cockpit cannot see your screen, so it reports four states and never a fifth:

| State | Meaning |
| --- | --- |
| `NOT TESTED` | no test notification was sent in this session |
| `ATTEMPTED` | a send was made and the host did not report writing it (the reason is shown) |
| `SENT` | the host reported the channel it wrote to; it cannot tell whether your terminal showed it |
| `USER CONFIRMED` | you typed `/cockpit guard seen` after a test in this session. Your statement, not proof of delivery |

- `/cockpit guard test` sends one notification that says it is a test and shows a four-character code. `/cockpit guard test sound` also tries the alert sound (it is tried anyway when `guardSound` is on). The sound's outcome is recorded apart from the notification's.
- `/cockpit guard seen <code>` confirms it with the code the notification showed; the code appears nowhere else. `/cockpit guard seen` without a code is accepted only for a channel that rings the bell and shows no text, and is recorded as confirmed without the code.
- Limits of its own: one test every 30 seconds, six per session, a confirmation within 10 minutes of its test. Tests use none of the alert budget or cooldown and are not written to the alert records.
- A confirmation belongs to the session it was made in and to the same kind of connection (an SSH session or not), and counts for 12 hours. A new session starts `NOT TESTED`, and a newer test that was not confirmed replaces an older confirmation.
- `/cockpit guard` and `/cockpit doctor` show the channel the host reported, whether it is the bell only, the sound outcome, the last test and its age, the last confirmation and whether it applies now, and a warning while alerts are armed and nothing was confirmed in this session.
- Both commands are accepted only when typed by a person, and neither changes a gate, a hold, a review, a release approval, the task's percentage or an alert.

What is known, from Claude Code's own declarations: its notification channels are iTerm2, kitty, Ghostty and the terminal bell, and when its automatic setting finds no notifying terminal it reports `no-channel`. What follows from that is expectation, not something tested for this release: a terminal that is none of those (KDE's Konsole, for example) should get no popup from the host, and should get the bell if you set Claude Code's `preferredNotifChannel` to `terminal_bell`; what a bell then does (a sound, a taskbar flash, a desktop notification) is your terminal's own setting; and over SSH the sequence or bell should be carried in the terminal stream to your local terminal, which decides what to do with it. None of this was observed on Konsole or over SSH. Cockpit detects that the process was started in an SSH session, cannot detect a reconnect, and cannot tell whether anything arrived. The alert sound is different: it plays on the machine Claude Code runs on. On a remote machine an audio player that answers there plays where you cannot hear it, and the bell, the last player in the chain, is tried only when no audio player answers; that bell is the only part of the sound that could reach you. Cockpit starts no desktop notifier, service or tunnel. Test where you work, and test again after reconnecting.
