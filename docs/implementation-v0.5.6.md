# v0.5.6: alert priorities, quiet hours and the pinned alert row

v0.5.5 established, with a person at the terminal, that Cobalt Guard's notification reaches the operator over SSH as a terminal bell. This release makes the alerts less intrusive (quiet hours, notified kinds) and harder to miss (a pinned HUD row), without changing what is sent when no new option is set. Policy is pure: `hooks/quiet.ts` (the window) and `hooks/alerts.ts` (levels, kinds, deferral, pins, wording). `hooks/register.tsx` owns the host calls, the one timer and the HUD row.

## Priorities

| Level | Kinds |
| --- | --- |
| CRITICAL | `security-failure` |
| HIGH | `release-no-go`, `verification-exhausted`, `review-hold` |
| NORMAL | `run-blocked` |

The table is fixed in code (`LEVEL`, `PRIORITY`); there is no rules engine. A level does three things: it orders the HUD row, it colours it, and CRITICAL is the class quiet hours treat apart. It does not reorder sending: the order alerts are told in is exactly v0.5.5's, so the cooldown lets through the same alert first as before.

## Notified kinds

`guardNotifyKinds` is a list of kind names. A critical kind is always in it. A kind that is out is not sent and not lost: one `silenced` record with the reason `kind-off` is written, and the condition is pinned and listed. A value that cannot be read (not a string, no known name) notifies every kind, and unknown names are counted, never echoed.

## Quiet hours

**The window.** `guardQuietHours` is `HH:MM-HH:MM`, start inclusive, end exclusive, and may cross midnight. Membership is decided on the wall-clock minute of the day in one zone, read through the runtime's own time-zone data (`Intl.DateTimeFormat` with `timeZone`). Nothing is computed ahead and nothing is remembered between looks, so:

- **Daylight saving.** A window across a skipped hour is an hour shorter that night; a window wholly inside the skipped hour does not open that night; a window in a repeated hour is open both times. This is what "22:00 to 07:00" means on a wall clock, and it is stated in the status.
- **Clock changes.** A clock that jumps forwards or backwards is simply read again. A moment that cannot be read is treated as outside the window.
- **The zone.** `guardQuietTimezone` when set; otherwise the machine's own zone, which the status names together with the time there, and warns about when the process was started in an SSH session (the machine's zone is then likely not the operator's). An unknown zone, an unreadable window, a zero-length window or an unknown mode turns quiet hours off (`NOT IN FORCE`) with a closed reason: a setting that was not understood is never why an alert went unsent.

**What "deferred" does, and why.** The confirmed channel is `terminal_bell`, where the host's notification is itself the bell: it rings whether or not `guardSound` is on. Muting the separate cue would therefore not make an alert quiet. So a deferred alert makes no `$.ui.notify` call and starts no player. Nothing is written to the terminal, which is the only silence the host can promise. The three behaviours are kept apart in the records and the wording:

| Behaviour | What happens | How it is reported |
| --- | --- | --- |
| deferred | no notification, no sound; record `deferred` (reason `quiet`) | `DEFERRED, quiet hours`; pinned on the HUD |
| sent in the window (`notify`) | the usual notification; the extra cue is not played | `AUDIBLE` on `terminal_bell` and `iterm2_with_bell`; elsewhere "whether that makes a sound is decided by your terminal and desktop"; unknown channel: "may be audible" |
| sent outside the window | as v0.5.5 | as v0.5.5 |

No notification is ever described as silent. The channel named is the one the host last reported writing to in this session (an alert's or a test's).

**After the window.** The existing 30-second host timer (`$.clock.every`) now also exists while a deferred alert is owed, and each look re-reads the clock. When the window is over:

- one deferred condition is told with its usual sentence;
- two or more are told as one notification (a count, the gravest one's fixed sentence, a task number), which costs one unit of the session budget;
- a condition that resolved meanwhile is recorded `resolved` and never announced (this holds with persistent alerts off as well);
- a condition acknowledged meanwhile is not announced: the person already knows;
- a reminder that came due in the window is one reminder, because reminders are decided from the kept records and not queued;
- the cooldown, the session budget and the retry cap apply as always. If the budget is spent the condition is recorded as held back and stays pinned.

The timer is cancelled when nothing is owed and nothing can be repeated, on session end, and by the host on a reload; `session.start` re-arms it from the kept records.

## The pinned alert row

The HUD already had one `GUARD` row while alerts are on. It is now a pin while a raised condition still holds and is not acknowledged, or while the transport is unconfirmed:

- **Raised** means the engine wrote a record for the condition's current occurrence, so a condition that is only told at a stop (an open review) is not pinned mid-run.
- **Still holds** is read from the task at draw time, so a pin goes as soon as the gate passes, the block is lifted or the task is reset, whether or not an alert pass has run since.
- **Acknowledged** is the latest record of the occurrence being acknowledged: `/cockpit guard ack` clears the pin, and a notification written after it is news again.
- The text is the widest of seven forms that fits the band; the narrowest are `▲ CRITICAL +2`, `▲ CRITICAL` and `▲`. It is static, so reduced motion changes nothing. CRITICAL is the failure colour, HIGH and NORMAL the warning colour; with nothing to pin the row is the dim `GUARD: ARMED` of v0.5.5, and with alerts off there is no row.
- It says what the host reported (`SENT`, `NOT SENT`, `DEFERRED`, `HELD BACK`, `NOT NOTIFIED`). No form contains "seen", "heard" or "delivered".

A new condition raised while the session is silenced is now recorded (`silenced`) so that it can be pinned; it is still not notified. This is the one addition to what v0.5.5 writes when no new option is set. The row itself is the one visible default change: with alerts on it adds `transport not confirmed` until a test is confirmed in the session, and becomes a pin while a raised condition is open.

## Known limits

- **A recurrence with persistent alerts off.** v0.5.5 records `resolved` only with `guardRepeat` on, so without it a condition that clears and holds again in the same task is one occurrence: it is not notified a second time (unchanged), and the pin then reads `notification SENT, not acknowledged` about the earlier notification. With `guardRepeat` on the recurrence is a new occurrence and is told again.
- **A misspelled kind.** In `guardNotifyKinds` an unknown name is ignored, so `run-blocked,reveiw-hold` notifies `run-blocked` only. `/cockpit guard` and `/cockpit doctor` warn and list exactly what is and is not notified; check that line after changing the setting. A list with no known name at all notifies every kind.
- **Silence acknowledges.** `/cockpit guard silence` acknowledges everything recorded so far, deferred alerts included, so those are not announced after `unsilence`. Only a condition first raised during the silence stays pinned.
- **A deferral that can no longer be told** (three failed sends, the budget spent, its kind turned off, or the session silenced) is no longer counted as owed and does not keep the timer alive; it stays pinned with its real state.

## Safety properties, and where they are tested

- Alert, deferral, digest, acknowledgment and pin change no gate, hold, review, approval or percentage (`tests/alerts-quiet.test.ts`, "no verdict moved"; the v0.5.2–v0.5.5 suites are unchanged and pass).
- No duplicate reminders; acknowledgment stops them (unchanged suites; "acknowledged before the window ends").
- The five new settings are refused from a plugin, the bridge or an unknown origin (`tests/guard-settings.test.ts`).
- Notification text is a closed vocabulary and numbers; unknown kind names and bad setting values are never echoed.
- Records stay bounded (32); new outcomes are validated on load and a malformed one is dropped. An older build that loads a ledger with `deferred` records drops those records and keeps the rest.

## Tests

`tests/alerts-quiet.test.ts` (74 tests; `tests/guard-settings.test.ts` gains 10 for the new settings): window parsing and membership across midnight; configuration and every unreadable form; zones, a half-hour offset, spring forward, fall back, an unreadable or jumping clock; levels and ordering; notified kinds; deferral bookkeeping; the digest text; the pin's lifecycle, statuses, width fitting from 0 to 170 columns and wording; the status lines; and, through the host: deferral with no notification and no cue, the end of the window on the timer alone, the critical default, a deferred critical alert staying visible, no flood, reminders across a long window, acknowledgment and resolution before the end, task reset and replacement, session end, silence, budget, unreadable settings, another zone, the bell-only channel, kinds, the HUD row with alerts off / unconfirmed / confirmed / pinned / acknowledged / resolved / failed / narrow / reduced motion, doctor, reload inside and after the window, a stored deferral of a task that is gone, and malformed stored records.

These are synthetic. None of them shows that a person saw, heard or was spared anything.

## Operator configuration

All in Claude Code's config menu, under Cobalt Cockpit (they cannot be set by a plugin or a model):

1. `guardAlerts`: on. Optionally `guardRepeat` and `guardSound`, as before.
2. `guardQuietHours`: for example `22:00-07:00`.
3. `guardQuietTimezone`: your zone, for example `Europe/Berlin`. Set it whenever Claude Code runs on another machine than the one you sit at.
4. `guardQuietOrdinary` (`defer`) and `guardQuietCritical` (`notify`): leave as they are unless you want ordinary alerts through, or critical ones held.
5. `guardNotifyKinds`: leave empty for every kind, or list the ones you want.
6. Restart or reload, then run `/cockpit guard`: check the `Quiet hours:` line shows your window, your zone and the right time there, and `/cockpit guard test` then `/cockpit guard seen` so the transport reads `USER CONFIRMED`.

## Human acceptance procedure

Run at the terminal you actually use. Type the commands yourself. Each step says what to look for; if you do not see it, it is not accepted.

1. **Status.** `/cockpit guard`. Expect the `Priority:`, `Notified kinds:` and `Quiet hours:` lines, and the time shown "there" to match your own clock.
2. **Unconfirmed transport on the HUD.** In a fresh session with alerts on, the HUD row should read `GUARD: ARMED · transport not confirmed`. Run `/cockpit guard test`, then `/cockpit guard seen`: the row should become `GUARD: ARMED`.
3. **Pin.** Outside the window, have a task blocked (the synthetic blocked-task prompt used for v0.5.5 works). Expect the bell or popup as before, and the row `GUARD ▲ NORMAL run blocked · task N · notification SENT, not acknowledged`. Run `/cockpit guard ack`: the pin should go. Reset the task.
4. **Deferred alert.** Set `guardQuietHours` to a window that contains the present minute and ends a few minutes from now. Block a task. Expect no bell, no flash and no popup; the row `GUARD ▲ NORMAL run blocked · … · DEFERRED, quiet hours`; and `/cockpit guard` listing it as `ACTIVE … DEFERRED` with one alert owed.
5. **End of the window.** Do nothing. Within about 30 seconds after the window's end, expect exactly one bell or popup, and the row changing to `notification SENT, not acknowledged`. Wait several more minutes: expect no further notification unless `guardRepeat` is on.
6. **Critical in the window.** Inside a window, report a failed SECURITY gate on a test task. With the default settings expect the bell at once, and `/cockpit guard` saying critical alerts are `still sent · AUDIBLE` on your bell channel.
7. **Narrow terminal.** Shrink the terminal while a pin is shown: the row should shorten and keep `▲` and the level.
8. Restore your real window, reset the test task, and `/cockpit guard ack`.

## What was not observed

Automated tests exercise the policy and the host calls against the plugin test host. Not observed for this release, and so NOT VERIFIED until the procedure above is run by a person:

- that a deferred alert produces no bell, flash or popup at a real terminal (the tests show only that no notify call and no player is started);
- that the notification after the window is seen or heard;
- the pinned row's appearance, colour and truncation in WezTerm, and its behaviour with other plugins drawing in the same band;
- behaviour across an SSH disconnect and reconnect during a window;
- quiet hours across a real daylight-saving change (covered with fixed instants only);
- the window on a machine whose runtime lacks time-zone data (the code then reports the zone as unknown and applies nothing).
