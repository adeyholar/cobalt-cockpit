# v0.5.4: persistent alerts

An opt-in extension of Cobalt Guard's owner alerts. The policy stays in `hooks/alerts.ts` (pure functions over the kept records); `hooks/register.tsx` owns the timer, the host calls and the commands. With `guardRepeat` and `guardSound` off, behaviour is that of 0.5.3.

## Lifecycle

| State | How it is reached | What follows |
| --- | --- | --- |
| told | a due condition's first notification was written (`sent`) | reminders may follow |
| reminded | still open after `guardRepeatSec`, inside every bound | record carries `nth` |
| acknowledged | `/cockpit guard ack` or `silence`, typed by a person | no more reminders for that occurrence |
| silenced | `/cockpit guard silence` | nothing is sent this session until `unsilence` |
| resolved | the condition no longer holds, or its task is gone | recorded once, no notification; a return is a new occurrence |
| spent | `guardMaxReminders` reached, or the session budget | nothing more for that occurrence |

Everything is derived from the alert records in the Run Ledger (`episodeOf`, `remind`, `closedOf`, `hasReminderLeft`), so a reload or restart resumes a count. `GuardState` gained no field.

## Bounds

A reminder is sent only when all hold: persistence on; not silenced; the occurrence has a written first alert and no acknowledgment; fewer than `guardMaxReminders` reminders (failed ones count); the session has more than one alert left (`guardMaxAlerts`; the last is reserved for a condition not yet told); `guardRepeatSec` since the occurrence's last notice; `guardCooldownSec` since any alert. A clock that goes backwards waits.

## Timer

One `$.clock.every` timer (30 s, or the interval if shorter) exists only while `hasReminderLeft` is true. `armReminders` is the single place that creates or cancels it: after every `raiseAlerts`, after `ack`/`silence`/`unsilence`, at `session.start` (which is how a reload resumes) and `session.end`. A tick calls the same `raiseAlerts` as every other caller, behind the same re-entry guard, so a tick during a raise does nothing.

## Delivery and what is claimed

- Notification: the host's `$.ui.notify`. `sent` means the host reported the channel it wrote to. ATTEMPTED and SENT are recorded; DELIVERED or seen is never claimed.
- Sound (`guardSound`): the existing `sound()` cue player and its player chain, whose last entry is the terminal bell; it honours `sounds` and `/cockpit mute`. `cue: sound|bell` records that a player exited 0.
- Desktop: no desktop notifier is started. Terminals that implement the host's notification channel show their own popup. From a remote machine, whether that reaches the operator's desktop depends on the terminal and connection. This is unverified and is listed as interactive acceptance.

## Rejected alternatives

- A `notify-send` (or other) desktop process: a new program to run, and on a remote machine it would notify the remote session, not the operator.
- A second, separate reminder state atom: the records already hold everything, and a second source could disagree after a reload.
- Repeating without an acknowledgment check on the timer path only: an acknowledgment must end repeats on every path, so the rule lives in `remind`.

## Tests

`tests/alerts-persistent.test.ts`: configuration clamps and opt-in; the reminder rule (interval, cap, failed reminders, acknowledgment, silence, cooldown, reserved budget, backwards clock, new occurrence after resolution); timer-only repetition; no verdict change; acknowledgment; silence and unsilence; person-only `unsilence`; resolution and return; reset and new task; session end; failing notifications; budget and cooldown spacing; closed message text; sound, bell fallback and mute; reload resuming with one timer; acknowledged reload; stale stored record; malformed stored state.

## Remaining human acceptance

On the operator's own terminal: enable `guardAlerts`, `guardRepeat` (and `guardSound`), block a task, and observe the first notification, a reminder after the interval, silence after `/cockpit guard ack`, and the sound. Repeat from the remote Boat machine to learn whether the notification and bell cross the connection.
