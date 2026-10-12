# v0.5.7: alert inbox and recovery

v0.5.6 established, with a person at the terminal, that Cobalt Guard's notification reaches the operator over SSH (readable WezTerm notifications, quiet hours). This release makes the record of those alerts something the operator can read, act on and recover after stepping away. It adds no notification path: `$.ui.notify`, the terminal bell fallback, the verified transport, persistent reminders, quiet hours, priorities, per-kind policy, budgets, cooldowns and the single 30-second timer are as they were. Policy is pure in `hooks/alerts.ts`; `hooks/register.tsx` owns the host calls.

## What it adds

| Piece | Where |
| --- | --- |
| Occurrence identity: `episodesOf`, `bounded` stamping | `hooks/alerts.ts` |
| Inbox model and text: `occurrencesOf`, `inboxOrder`, `inboxText`, `unreadOf` | `hooks/alerts.ts` |
| Individual acknowledgment: `ackOccurrence`, `withAck`, `isAckedSince` | `hooks/alerts.ts` |
| `/cockpit alerts`, `/cockpit alerts ack <id>` | `hooks/register.tsx` |
| Per-project durable history (`alert-history`), seeded once per session | `hooks/register.tsx` (`persist`, `seedAlerts`) |
| HUD unread count | `pinLine` in `hooks/alerts.ts` |
| Tests | `tests/alerts-inbox.test.ts` |

## The model: one store, read as occurrences

The Run Ledger's `alerts` array (newest 32) stays the only event history. An **occurrence** is a condition's records from the first one kept to the `resolved` mark that closed it, or to the latest. Nothing else is stored about it: its level, task, outcome, channel, reminder count, acknowledgment and "ended/open" state are read off the records and the task as it is now.

- **Identity.** Every record is stamped with an optional `id`, 8 lowercase hex digits: a 32-bit FNV-1a of the condition key and the moment of the occurrence's first record, re-salted on a collision. The key already includes the task's identity (`lineage` or `id@startedAt`), so a task number reused after a reset is a different occurrence. A record from v0.5.6 has no `id`; one is derived the same way and, once the occurrence is written to again, stamped, so it does not change. Eviction of earlier records of an occurrence does not change its id. A stored `id` that is not 8 lowercase hex digits makes the record invalid, and the record is dropped (as any malformed record is).
- **Open.** `open` means the condition holds in the current task (`dueOf` over its facts, as the HUD already did). `resolved` means a `resolved` record closed it. `ended` means neither: the task was replaced or is gone and no resolution was recorded yet (for example, in a session that started without the task). History is not re-checked against anything else.
- **Order.** Open and unacknowledged (gravest first, then most recently written), open and acknowledged, then the rest newest first. "Most recently written" is the position in the records, not the clock, so a clock stepped back does not reorder them.
- **Display.** Eight occurrences a page, at most 32 occurrences in all. Lines carry level, kind, task number, the recorded time (UTC, with an age when the clock is not behind the record), the host-reported outcome, acknowledgment and open state. No key, path, command, prompt or free text is in them.

## Acknowledging one occurrence

`/cockpit alerts ack <id>` (person-only, the same allow-list as `/cockpit guard ack`: the terminal's Enter and the Remote Control bridge). It marks every record of that occurrence `acked` and nothing else. Because reminders and the pin already read `acked`, reminders for it end at once (`remind` answers `acknowledged`), the pin goes, and the timer re-arms from the records. A deferred occurrence acknowledged before anything was written is not announced afterwards (as in v0.5.6). One held back by the cooldown or budget is still told when they allow it, and a failed send is still retried (each retry is a new, unacknowledged record): acknowledging must not silence a condition, `/cockpit guard ack` included, that nobody was told of. It touches no gate, hold, review, approval, percentage or other occurrence.

- Malformed (not 8 lowercase hex after the command lowercases it), unknown, and expired ids change nothing and say so. An expired id is indistinguishable from a mistyped one, and the message says both.
- An occurrence already acknowledged says so and changes nothing. One whose condition no longer holds can be acknowledged; the answer says that this only marks the record.
- A notification being written when the acknowledgment is typed is born acknowledged (see the next section).

## Two v0.5.6 limits corrected

1. **Recurrence with `guardRepeat` off.** `resolved` was written only with persistence on, so without it a condition that cleared and held again was one occurrence: not told again, and the pin described the earlier notification. `resolved` is now recorded for every condition that was told and no longer holds. A recurrence is a new occurrence, told again within the cooldown, the session budget and the retry cap; the status says "the same occurrence never twice". A flapping condition is therefore bounded by those three, not by one-per-task. This is a deliberate behaviour change for users who run with `guardRepeat` off.
2. **Clock rollback.** A notice was born acknowledged when its decision time was not after the last acknowledgment's time, so a clock stepped back past an acknowledgment made a new record read as acknowledged. The state now counts acknowledgments (`seq`, `ackSeq`, `ackedKeys`, the last eight single acknowledgments) and a pass notes the count when it begins deciding; a record is born acknowledged only if an acknowledgment of that condition (or of everything) was made after that. Reminders and the cooldown still wait, rather than fire, when the clock is behind a record.

The long-window test shortened in v0.5.6 stays at one hour of mock clock on the host (the timer ticks every 30 seconds, and 5 hours of ticks was the part that ran long). The 5 hours 45 minutes it once covered is now a pure test of `remind`: one reminder due at the end of any window, then one a whole interval later, however many intervals the window held.

## Recovery and persistence

The Run Ledger is per session id, and a new session starts with an empty one, so after a restart that is not a resume the alerts were gone. The smallest compatible extension follows the Stop guard's precedent (`stop-checks`): a plugin-store key of its own.

- **`alert-history`**: `{ v: 1, projects: { <12-hex project hash>: AlertRecord[] } }`. The hash is a SHA-256 of a fixed prefix and the session's working directory, truncated; the path is never stored. At most four projects (the oldest forgotten first) and 32 records each, in the Ledger's own record format and validation. It is written from `persist` whenever the Ledger has alerts, replaced per project, and not written at all when there are none. A damaged value, project name or record is ignored on read.
- **Seeding.** Once per session, a Ledger with no alerts of its own takes up its project's history; a Ledger that has alerts (a resumed session, or v0.5.6's) keeps them and is tied to the project. `Ledger.alertsProject` records which project the alerts belong to, so a session whose directory changes later does not write its alerts into another project's history. Concurrent sessions of one project: the last writer's records are the project's history (the Ledgers each keep their own).
- **No flood.** Seeding records nothing and sends nothing. The same task carried into a new session has its records, so `decide` answers `duplicate` and `remind` continues the count; a condition whose task is gone is recorded `resolved` at the first look and never announced; something quiet hours held back is still owed, once, and is the one thing a restart does not cancel. The session budget and cooldown start fresh in a new session, as they always did.
- **Retention.** 32 occurrences' worth of records per project (fewer when an occurrence has many reminders), four projects. A full store gives up held-back and silenced records first, then closed occurrences, so an open condition's records are the last forgotten. Records outside the bound expire; the id of an expired occurrence is "unknown".

## HUD

The one `GUARD` row is unchanged while a condition is pinned (its widest form now ends `/cockpit alerts` instead of `/cockpit guard`), and unchanged for an unconfirmed transport. New: when no condition is pinned but recorded occurrences no longer hold and were never acknowledged, the row reads `GUARD: ARMED · 2 unacknowledged in history · /cockpit alerts` (shortening to `2 unack` and then the plain label as the band narrows). It counts records, not people: it says nothing about whether anything was seen. An open critical condition stays pinned until it is acknowledged or resolved. With alerts off there is still no row.

## Privacy

See `PRIVACY.md` (Owner alerts). New data: the 8-hex occurrence id on each alert record, `Ledger.alertsProject` (12 hex of a hash), and the `alert-history` key holding records the Ledger already held. Not new: no prompt, source, command, credential or path is kept or shown. The notification text is unchanged and was already a closed vocabulary and a task number.

## Compatibility

- A v0.5.6 Ledger loads: records without `id` are valid, `alertsProject` is absent and set at the next write. v0.5.6's `ackAt` in a held guard state is ignored.
- An older build loading a ledger written by this one ignores the new fields; its `isAlertRecord` does not reject an extra `id`. Its guard state ignores `seq`, `ackSeq`, `ackedKeys`.
- The notification texts, the `/cockpit guard` output (other than "the same occurrence never twice") and every setting are unchanged. The Stop-hook verification guard, gates, review holds and release approvals are not touched.

## Known limits

- **A cleared condition that recurs before any look.** A look happens at tool results, stops and the timer. A condition that clears and holds again between two looks is one occurrence, with or without persistence.
- **A concurrent session in one project** overwrites the project's history with its own records when it records something (last write wins); each session's Ledger is intact. When a session writes, occurrences it never saw that the history holds are kept beside its own (oldest forgotten first), so a resumed older session does not erase a newer one's.
- **A shared occurrence** that two sessions both hold is written with the writing session's copy: an acknowledgment or reminder recorded only by the other is lost from the stored history (not from its Ledger). Occurrences the writer never saw are placed before its own, not by age.
- **Eviction and the 30-second gap.** When the records are full, the oldest held-back record goes first, which can be an open condition's only record; the next look writes it again (as in v0.5.6).
- **Seeded but stale.** A seeded record of a task that is gone reads `ended` (and the label `SENT`) until the first look records it resolved.
- **The HUD count** is shown when nothing is pinned; while a condition is pinned, only `+N more` is.
- **An expired id** cannot be told from a mistyped one.
- **Times** are this machine's clock as recorded, shown in UTC. A clock changed by a person or by NTP can put recorded times out of order; the list keeps the order records were written.
- **"Open now"** is evaluated for the current task only; an occurrence of another task in the same project reads as no longer open.
- **No connection state.** Cockpit does not observe SSH disconnects or reconnects and the inbox never says it did.

## Tests

`tests/alerts-inbox.test.ts`. Pure: identity (stamping, recurrence, task-number reuse, legacy derivation, eviction, collision, malformed ids), the model (ordering, fields, statuses, unread count, pages, privacy and wording of the text), acknowledgment (exactly one occurrence, reminders, idempotence, bad ids, cleared conditions, a recurrence, held-back occurrences, the count), recurrence and the clock, the long-window rule, and the HUD row at every width. Through the host: listing, several conditions at once, acknowledgment by one and by `guard ack`, person-only, bad ids, a cleared condition, a recurrence with persistence off and on, the cooldown on a recurrence, a reset task and a reused number, reminders after an acknowledgment, an acknowledgment racing a notification, alerts off, paging, narrow bands, the Ledger and project history, a new session, the same task carried over, another project, the four-project bound, damaged histories (seven shapes), v0.5.6 records, hot reload, the caps, quiet hours (deferred, critical, after the window) and "no verdict moved". They are synthetic: none shows that a person saw, heard or was spared anything.

## Commands to try

```
/cockpit alerts                     the inbox, page 1
/cockpit alerts 2                   page 2
/cockpit alerts ack 3f9a02bc        acknowledge exactly that occurrence
/cockpit guard ack                  acknowledge everything (as before)
/cockpit guard                      status, priorities, quiet hours, active conditions
```

## Human acceptance procedure

Run at the terminal you use, typed by you. Each step says what to look for; if you do not see it, it is not accepted. Everything below is NOT VERIFIED until you do it.

1. **Empty.** In a fresh session with `guardAlerts` on: `/cockpit alerts` says `Nothing recorded.` (or lists earlier records with the right dates).
2. **A listed alert.** Block a task (the blocked-task prompt used for v0.5.5). Expect the bell or popup as before; then `/cockpit alerts` shows one `NORMAL run-blocked` line with `notification SENT via <your channel>`, `not acknowledged` and `condition OPEN now`, and the HUD pin.
3. **Two conditions.** Report a failed SECURITY gate as well. Expect `CRITICAL security-failure` above the `NORMAL` line and `+1 more` on the pin.
4. **Acknowledge one.** `/cockpit alerts ack <id of the CRITICAL line>`. Expect the line to read `acknowledged`, the pin to name the other condition, and no change to the task's gates or percentage. Try a wrong id (`00000000`) and a malformed one (`xyz`): both answer without changing anything.
5. **Resolve and recover.** Reset the task. Expect both lines under `HISTORY`, `no longer open`, and a row `GUARD: ARMED · N unacknowledged in history · /cockpit alerts`. Acknowledge each: the row loses the count.
6. **Restart.** Raise one alert, leave it unacknowledged, quit Claude Code and start a new session in the same directory. Expect `/cockpit alerts` to list it under `HISTORY` (or `OPEN NOW` if you resumed the session with the task) and **no** new notification.
7. **Quiet hours.** With a window containing the present minute, block a task: no bell, `DEFERRED, quiet hours` in the inbox. `/cockpit alerts ack <id>` before the window ends: no bell afterwards.
8. **Narrow terminal.** Shrink the terminal with a pin or the count shown: the row shortens and keeps `▲` or `GUARD:`.

## What was not observed

Automated tests run against the plugin test host. Not observed, so NOT VERIFIED until the procedure above is run by a person: any real terminal, WezTerm or Konsole rendering of the row, the notification reaching a person after a restart, behaviour across an SSH disconnect and reconnect (the plugin does not observe either), a new session in a real project directory (the tests use a mocked directory and store), and two live sessions in one project.
