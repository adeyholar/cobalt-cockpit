# v0.5.9: record-only mode and the since-last-look summary

v0.5.8 made acknowledgments durable and shared. This release lets an operator who does not want notifications still have incidents recorded, adds a compact count of what is new since the operator last displayed the inbox, and moves each occurrence's records to a key of its own so that sessions recording different occurrences cannot lose each other's. The notification path (`$.ui.notify`, the bell fallback, the verified transport, reminders, quiet hours, priorities, kinds, budgets, cooldowns, the single timer) is untouched.

## Operating modes

| `guardAlerts` | `guardRecordOnly` | New incidents | Notifications, sounds, bells |
| --- | --- | --- | --- |
| off | off | not recorded | none. Earlier history can still be read (`/cockpit alerts`, `digest`, `ack`). |
| on | off | recorded as always | as always |
| off | on | **recorded** (`recorded` outcome) | **none, ever** |
| on | on | recorded as always | as always: alerts take precedence |

The last row is deliberate and visible: `guardRecordOnly` is never a way to mute alerts. `/cockpit guard` says "guardRecordOnly is also on: it changes nothing while alerts are on", the doctor line says the same, and the label stays `ARMED`. Nothing silently disables a safety-relevant notification policy because two settings are both on.

`guardRecordOnly` is in the person-only setting list (`GUARD_FIELDS`): a plugin, the bridge or an unknown origin cannot set it (tested with the other alert settings). It is off by default and consent is the setting: with both off, nothing is recorded, the Ledger is not tied to a project (`alertsProject` stays absent) and no `alert-*` key is written (tested).

## Record-only behaviour

`raiseAlerts` runs when recording (`isRecording`: alerts or record-only) instead of only when alerts are on. With alerts off it takes a separate branch that, for each condition `dueOf` returns, writes one record `{ outcome: 'recorded', attempts: 0, channel: null }` if the condition's current occurrence has no record yet, and returns. It does not call `decide`, `notifyOwner`, `cueOwner` or the quiet-hours check; it does not touch the guard state's count or last-sent time (the session budget and cooldown), arm the timer, or send reminders. Resolution reuses the existing path (`closedOf` / `lapsedOf`), with `recorded` counted among the records that open an occurrence; a recurrence is a new occurrence with a new id. Silence (`guard silence`), `guardNotifyKinds` and quiet hours decide whether something is *told*; they do not stop it being *recorded*, and no `deferred` or `silenced` record is written in this mode.

- **The outcome.** `recorded` is a new member of the alert outcome set (types and validation). It maps to the status `recorded` (`RECORDED only, no notification` in the inbox, `RECORDED, no notification` on the HUD and in `/cockpit guard`) and is never described as sent, failed, held back or deferred.
- **No backlog.** `decide` answers `{ send: false, why: 'recorded' }` for an occurrence that has a `recorded` record, so turning alerts on later announces nothing that was already recorded. The occurrence stays unannounced until it resolves; a recurrence, or any new incident, is told as usual with a fresh budget and cooldown. This is deliberate and means an operator who turns alerts on while a recorded critical condition is still open is not told of it; the HUD pin and the inbox still show it.
- **Manual tests.** `/cockpit guard test` is typed by a person and sends its one labelled TEST notification in any mode. It writes no alert record. Nothing automatic sends in record-only mode (tested: no notification, no player, no bell, over hours, with `guardSound` and `guardRepeat` set).
- **Migration and downgrade.** Existing records are valid as they are. A v0.5.8 build that loads a record with the outcome `recorded` drops that record (it validates the outcome set) and keeps the rest; a v0.5.8 build also reads only the earlier history keys, so it does not see occurrences written to the new keys. Nothing in v0.5.9 rewrites or deletes the earlier keys.

## Since your last look

`/cockpit alerts` begins with `ALERT INBOX · …` and then `SINCE LAST LOOK: 1 CRITICAL · 2 HIGH · 3 NORMAL` (levels with none are left out, so one critical reads `SINCE LAST LOOK: 1 CRITICAL`; `nothing new` when so; `(no earlier look)` when no marker exists), and a second line when there is anything new and the width allows: active versus history, recorded only, SENT, DEFERRED, NOT SENT, HELD BACK, NOT NOTIFIED, acknowledged. The same lines appear in `/cockpit alerts digest`.

- **By identity.** "New" means the occurrence's id is not among the ids the last look displayed. Times are not compared, so a clock stepped back or equal timestamps change nothing. A task reset, a recurrence and a new incident are new occurrences with new ids. An occurrence whose state changes (acknowledged elsewhere, resolved, a reminder) is not new again.
- **The marker.** `alert-seen:<project>` holds `{ v: 1, ids }`, at most 64 ids, for four projects at most. A look writes the union of what the key held and what the page it displayed showed, with one `set`; only the ids on the displayed page are marked, so occurrences on pages never opened stay new. A value that is not that shape is treated as no marker (everything is new, nothing throws).
- **Who looks.** Only a person-initiated `/cockpit alerts [page]` (the terminal's own Enter or the bridge: `isHumanAuthority`), and only while alerts or record-only is on (with both off nothing new is kept, the marker included), writes the marker. `/cockpit alerts digest`, the `guardDigest` start-of-session line, any other origin, the HUD and the doctor read it or ignore it and never write it (tested). Looking never acknowledges anything and never sends a notification.
- **Across sessions: best effort, stated.** The marker is a read and a write of one key, not an atomic update, and the host has no compare-and-set. Two sessions looking at once can leave the key without the other's ids, so a later look counts those occurrences as new again. That can over-report; the union means a look never removes an id another look added unless their writes interleave, and an occurrence is never marked seen unless a person's look displayed it. The count describes records, not what anyone read: an unacknowledged or "new" record is not an unseen one, and no line says so.
- **Narrow terminals.** The summary takes the command's column count: the second line is dropped below 36 columns, trailing parts are dropped to fit, and the first line is truncated last (tested for every width in a range).

## HUD

With alerts on the row is what it was. With record-only on and alerts off:

- nothing recorded and nothing to count: **no row** (no permanent clutter);
- a recorded incident that is open and unacknowledged: `GUARD ▲ CRITICAL security check failed · task 3 · RECORDED, no notification · +1 more · /cockpit alerts`, shortened to `▲ CRITICAL` and `▲` as the band narrows, in the same colours, never animated, apart from the progress and verification rows;
- only history nobody acknowledged: `GUARD: RECORDING · 2 unacknowledged in history · /cockpit alerts`.

There is no `transport not confirmed` note in record-only mode: nothing is sent. The label is `RECORDING`, never `ARMED`.

## Storage and what the host guarantees

Unchanged facts (see `docs/implementation-v0.5.8.md`): the host's store takes a lock per `set` or `delete` and reads the whole file inside it; one `set` is serialised against another session's while the lock holds (a contended one can be rejected); there is no compare-and-set or transaction; `get` is unlocked; Cockpit adds no lock, retry loop or delay.

What this release changes in how the store is used:

| Data | Key | Written by | Can another session's write remove it? |
| --- | --- | --- | --- |
| An acknowledgment | `alert-ack:<project>:<id>` | one `set` | No (v0.5.8). |
| An occurrence's records | `alert-occ:<project>:<id>` | one `set` per changed occurrence | Only by a write to the **same** occurrence: the later write wins. A write to another occurrence cannot. |
| The look marker | `alert-seen:<project>` | read, union, one `set` | Interleaved looks can drop each other's ids (over-count). |

This replaces the v0.5.8 read-merge-write of the whole project history, which could lose an occurrence written between another session's read and write. Two sessions recording different occurrences now write different keys. The remaining loss is two sessions changing one occurrence at once (for example both holding the same open task and both sending a reminder), which is last-writer-wins; a resumed older session writes an occurrence only if it changed it itself, so an unchanged stale copy cannot overwrite a newer one (`occSigs`). The acknowledgment is separate in either case.

Reading: a new session lists the keys, reads the project's occurrences in the order the store lists them (the order they were first written; no clock), appends nothing from the earlier formats for an id a key already holds, and takes the newest 32 records. If two stored occurrences are of one condition and the earlier is still open (its task ended, or two sessions diverged), the earlier is closed in memory by a resolved mark so that grouping by condition cannot merge them and lose the later one's id.

Bounds: 32 occurrences per project and four projects, 128 acknowledgment keys, four look markers. The writing session deletes the oldest keys as the store lists them, its own occurrences last; the project it is writing for is never given up at project level, even when its keys are listed first. The key list is read, and keys given up, only when this session wrote an occurrence. If another session's pruning removed one of this session's occurrences, it is written again from the Ledger at this session's next write (it is not noticed before then).

The earlier formats: with alerts or record-only on, a session that finds this project's v0.5.8 key writes its occurrences to keys of their own and, once every one has a key, deletes that v0.5.8 key, so it cannot bring back what is pruned later. With both off they are read and not copied or deleted. The v0.5.7 single key `alert-history` is only ever read and is left in the store; an occurrence pruned from the new keys can reappear from it the next time a session starts in that project (delete the key `alert-history` from the plugin store to stop that).

Not guaranteed: that every session sees every other's records (a running session does not pull another's occurrences; a new session does), that a session sees another's acknowledgment before its next look (at most every five seconds on the alert pass), anything about stale-lock takeover or the host's file write (not examined), and any host version other than 2.1.296.

## v0.5.7 and v0.5.8 edge cases revisited

| Case | Result |
| --- | --- |
| Lost records after overlapping writes | Closed for different occurrences (keys of their own). Open for the same occurrence (last writer). |
| Expired occurrence and acknowledgment identity | An acknowledgment key can outlive the record. `/cockpit alerts ack <id>` for such an id now says "acknowledged earlier; its record has expired" instead of "unknown". Keys are bounded at 128; the oldest are forgotten first. |
| Eviction of an open condition's last record | v0.5.8: a held-back record that is all an open condition has goes last. A `recorded` record is never first to go either (it is not throttled or silenced). A live session's whole project is no longer given up by the four-project bound (found in review), and a key removed by someone else's pruning is written again at the next write. |
| Recurrence | A resolved occurrence recurring is a new occurrence in every mode. A recurrence between two looks is still one occurrence (looks happen at tool results, stops and the timer). |
| Clock rollback | Ordering is by key and record order, "new" is by id, acknowledgments by count: none reads the clock. Unchanged otherwise. |
| Cross-session acknowledgment | v0.5.8 keys, applied at each look. |
| Hot reload and restart | The Ledger survives a reload; a restart reads the keys. `occSigs` is primed for the occurrences the store already holds, so neither rewrites stored occurrences it did not change. No notification results from recovery (tested). |

## Tests

`tests/alerts-recording.test.ts` (57 tests). Pure: the settings and the four modes, the label and status text, active-condition lines, the `recorded` outcome (validation, status, no backlog on enabling, closing, reminder policy), the since-last-look lines (first look, by identity not time, active/history/status/acknowledged, widths 0–140, narrow forms), the marker (well-formed ids only, damaged values, cap, union, per-project bound), page ids, the digest's read-only counting, and the HUD row at every width. Through the host: record-only records and tells nothing (no notification, no player, no bell, no budget used) over hours, with `guardSound` and `guardRepeat` set; the inbox and digest; a critical pin until acknowledged; no row when empty; resolution and recurrence; person-only acknowledgment and its shared key; silence, kinds and quiet hours not preventing recording; a typed transport test as the only sender, recording no incident; no verdict moved; the guard status and doctor; both off; both on (identical notification text); switching modes (no backlog, a new incident told, record-only after alerts); since your last look (first, repeated, new, reset, restart, project switch, damaged marker, non-person origin, the digest and the start line writing nothing, acknowledgment elsewhere, narrow terminals); and storage bounds and project isolation. `tests/alerts-shared.test.ts` replaces the v0.5.8 merge tests with tests of the occurrence keys: interleaved writers, stale snapshots, conflicting and repeated acknowledgments, forty seeded schedules in which no written occurrence is lost and no acknowledgment is shown as undone, and the key bounds. They are synthetic: none runs two hosts or shows that a person saw anything.

## Configuration

In Claude Code's config menu, under Cobalt Cockpit (person-only): `guardRecordOnly` on, `guardAlerts` off, for recording without notifications. Add `guardDigest` for a one-line count at session start. With `guardAlerts` also on, nothing about alerts changes.

## Human acceptance for v0.5.9 (NOT VERIFIED until you do it)

Two sessions in one directory, started with `scripts/dev-launch.sh` from the committed tree, `guardRecordOnly` on and `guardAlerts` off in both.

1. **Records, nothing told.** In A, block a task and fail a SECURITY gate. Expect no bell, popup or sound. `/cockpit alerts` lists `CRITICAL security-failure` above `NORMAL run-blocked`, both `RECORDED only, no notification`; the HUD pins the critical one as `RECORDED, no notification`.
2. **Since your last look.** The first `/cockpit alerts` says `SINCE LAST LOOK: 1 CRITICAL · 1 NORMAL (no earlier look)`; a second says `nothing new`. `/cockpit alerts digest` and a session started with `guardDigest` do not change the next look's count. Raise one more incident: the next look says `1 …`.
3. **Another session.** Start B after A recorded. B's `/cockpit alerts` lists A's occurrences as history. Acknowledge one in A; in B it reads acknowledged after B's next look. Look in B and then in A: A's count of new may include what B looked at (best effort, as documented).
4. **Both settings.** Turn `guardAlerts` on as well and restart: a new failure is told with a bell; the incidents recorded earlier are not announced.
5. **Narrow terminal.** Shrink the terminal: the HUD row and the summary shorten and keep the level.

## What was not observed

Two live host processes sharing one store with record-only on; the terminal rendering of the HUD row and summary in WezTerm or Konsole; whether anyone sees a toast or a pin; the host's store behaviour in any version other than 2.1.296.
