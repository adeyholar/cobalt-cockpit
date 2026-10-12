# v0.5.8: inbox consistency and the return digest

v0.5.7 kept each project's alert records in one plugin-store key, and a session that wrote it from a stale snapshot could replace another session's acknowledgment with its own older copy. This release investigates what the host's store really guarantees, moves acknowledgments to where nothing can overwrite them, adds an operator-controlled digest, and lets the inbox work with notifications off. Notification delivery, quiet hours, priorities, budgets, cooldowns, the terminal bell fallback, the verified transport and the single timer are as they were.

## What the host's store guarantees (Claude Code 2.1.296)

The typed API (`$.store.get / set / delete / keys`) documents only: a JSON file of the plugin's own under the configuration directory; values are JSON; at most 4 MiB in all; keys over 256 characters are refused. It documents nothing about concurrency. What follows was read from the host's own implementation (the bundled code that serves the four calls), and is not a documented contract; it can change in a host release.

| Question | Finding |
| --- | --- |
| Is one `set` or `delete` mutually exclusive with another session's? | Yes while the lock is held, in this version. Each takes a lock file beside the store (`<store>.json.lock`), reads the whole file inside the lock, changes that key and writes. The lock is retried about ten times with short waits, so a contended `set` can be rejected (Cockpit's acknowledgment path reports that). Not examined: how the lock library takes over a stale lock, and whether the file write itself is a temporary file and a rename. |
| Does a `set` of one key disturb another key? | No: the other keys are read inside the lock and written back unchanged. |
| Is there compare-and-set or a transaction? | No. `$.state.set` has `ifVersion`, but `$.state` is held by the host for a session and is not shared between processes or kept on disk. |
| Is `get` locked? | No. A read can happen while another session writes; Cockpit treats an unreadable value as absent and never as a fact. |
| Can a plugin lock? | No. The lock is the host's own and is not exposed. |
| Key discovery | `keys()` lists every key, in insertion order. |
| Write order | The order in which sessions take the lock. Cockpit does not depend on it. |

So: a single `set` is serialised against other sessions' while the lock holds, a `get` followed by a `set` is not, and Cockpit makes no claim beyond that. In particular it does not claim that the stored history is race-free.

## Design: split by how it can be lost

| Data | Where | Written how | Can a stale session undo it? |
| --- | --- | --- | --- |
| An acknowledgment | `alert-ack:<project>:<id>`, value `{ "v": 1 }` | one `set`, never read back and rewritten | No: nothing rewrites it; two sessions acknowledging the same occurrence write the same value. Only the bound (below) deletes one. |
| A project's records | `alert-history:<project>` | read, `mergeHistory`, `set` | A record written between another session's read and its `set` can be missing from the stored history. It remains in its own session's Ledger. |

The acknowledgment is the one thing the person did on purpose, and it is the one thing kept where a read-modify-write cannot reach it. No spin, retry, sleep or plugin-level lock is used: they would not make a `get`/`set` pair atomic.

- **`syncAcks`** reads the key list, takes the keys of this project (`ackedIdsOf`: a key must be exactly `alert-ack:<12 hex>:<8 hex>`; anything else is ignored) and marks the Ledger's records of those occurrences acknowledged (`applyAcks`). It writes nothing to the store. It runs at the start of every alert pass (a tool result, a stop, the 30-second timer), at `/cockpit alerts`, at `/cockpit guard`, when a session starts, and when history is seeded. Marking the records is what ends reminders, clears the pin and stops a deferred alert being announced, with no new rule: the existing code reads `acked`.
- **`/cockpit alerts ack <id>`** marks the Ledger, then sets the key. If the set fails the answer says it holds in this session only. **`/cockpit guard ack` and `silence`** set a key for each occurrence they acknowledge (resolved ones are skipped). Both stay person-only (`isHumanAuthority`).
- **`mergeHistory`** (pure) keeps the occurrences the stored history has and this session never saw (placed before its own records), then this session's records, capped at 32; the ids acknowledged in the store, or marked in either copy, are applied to the result, so a merge never presents an acknowledged occurrence as unacknowledged. For an occurrence both hold, this session's copy is kept. The write happens only when this session's records changed since it last wrote or was seeded (`writtenSig`), so a resumed older session that records nothing writes nothing.
- **A resumed session** already tied to its project keeps the Ledger copy of its records and applies the acknowledgments in the store; it does not take up other sessions' records until it starts as a new session in that directory.
- **Cost.** The key list is read at most every five seconds on the alert pass (every tool result), and always at a command or a start; the host parses the whole store file for it.
- **Projects** each have their own history key, so a session in project A cannot replace project B's records. The project is a hash of the working directory (`alertProject`), tied to the Ledger when the Ledger has alerts (or when alerts are on).
- **Bounds.** 128 acknowledgment keys in all and four history keys, the oldest (in key order) deleted by the writing session (`excessAckKeys`, `excessHistoryKeys`). A deletion of a key another session also deletes is harmless. An acknowledgment key forgotten while its record survives (more than 128 acknowledgments in all, since the bound is global and a busy project alone can reach it) is the one way a key is lost to the bound; the `acked` flag in the acknowledging session's Ledger and in the stored history, which the merge also applies, still carries it.
- **v0.5.7 data.** The single `alert-history` key is read when a project has no key of its own, and is never written again. Acknowledged flags inside old records still count.

### What is and is not guaranteed

- **Guaranteed by construction (given the host behaviour above):** an acknowledgment written by a successful `set` cannot be replaced by another session's history write; two acknowledgments of different occurrences, or the same one, both hold; the merge cannot remove one; a session that never sees an acknowledgment key never invents one; an acknowledgment key is validated before it is believed (project and id shape).
- **Not guaranteed:** that the stored history has every record every session wrote; that a session sees another's acknowledgment before its next look (a tool call, a command, the timer, a session start; a session with alerts off and idle does not look until it runs a command); behaviour if the host changes its store locking; behaviour if something other than Cockpit edits the store file.
- **Not verified:** two live Claude Code processes on one store file. The tests drive the plugin in one process against a store they can write to as a second session would; they do not run two hosts.

## Return digest

`/cockpit alerts digest`: unacknowledged occurrences counted by CRITICAL / HIGH / NORMAL, how many hold now and how many are history, how many notifications were deferred, not sent or held back, and when the oldest was recorded, with a pointer to `/cockpit alerts`. At most eight lines whatever the history. It is computed from the records only (`digestOf2`): no model, no clock but the display age, no id, key, path or text from a record. It never says an alert was missed or unseen; the footer says it records what Cockpit wrote and what the host reported.

`guardDigest` (Cockpit settings, off by default, in the person-only list): at session start, if anything is unacknowledged, one line through the terminal's toast (`$.ui.toast`), not a desktop notification. It is marked in `alert-digest` (the last 16 session ids) before it is shown, so a hot reload, which fires the session start again, does not repeat it; a new session shows it again; nothing is shown when nothing is unacknowledged. The marker holds the session id and the moment: the line is not repeated for the same session within half an hour (a reload is seconds), so a *resumed* session, which keeps its id, is summarised again when it comes back later; a moment in the future (a clock stepped back) counts as recent. The marker is a read and a write of one key: two sessions starting at once can drop each other's entry, which can only show the line once more. The line counts levels only, not what holds now: the task may not be restored yet when a session starts, and `/cockpit alerts digest` has the open/historical split. A project switch is a new session in another directory and reads that project's history. It does not enable alerts, send anything or record anything.

## Notifications off

`guardAlerts` false no longer hides what is already recorded: `/cockpit alerts`, `/cockpit alerts digest`, `/cockpit alerts ack` and `guardDigest` work on history from earlier. Nothing new is recorded (the alert pass does not run), nothing is sent, and the HUD row stays off. A user with alerts off and no history gets no project tie on the Ledger, no history key and no acknowledgment key (tested). No setting was added to record without notifying: that would be new collection, and it is left for a decision.

## v0.5.7 edge cases reviewed

| Case | Result |
| --- | --- |
| Acknowledging a deferred alert | Not announced afterwards (unchanged). |
| Acknowledging a cooldown- or budget-held alert | Still told when the cooldown or budget allows, as in v0.5.6, because `guard ack` would otherwise silence a critical condition nobody was told of. The inbox shows it `HELD BACK`. Making an individual acknowledgment suppress it needs a distinction the records do not carry; not done. |
| Repeated incidents and identity | Unchanged: `resolved` closes an occurrence, a recurrence gets a new id. A recurrence between two looks is still one occurrence. |
| Expired identifiers | Unknown, as before; an acknowledgment key outliving its records is harmless and is dropped by the bound. |
| Task reset, reused numbers | Keys carry the task's identity; unchanged and tested. |
| Stale records from another session | Merged as above; a seeded record of a task that is gone reads `ended` until the first look. |
| Clock rollback | Acknowledgments are by count (v0.5.7); display order is write order. Unchanged. |
| Eviction | New: a held-back record that is all an open condition has is no longer the first to go (it was, in v0.5.6 and v0.5.7). When every record is such, the oldest still goes, to stay bounded. |
| Several sessions in one project | Acknowledgments converge; records are last-writer-wins. Each Ledger is intact. |
| Duplicate notification after recovery | None: records and acknowledgments are found, `decide` answers `duplicate`, and reminders continue the count (tested). |

An acknowledgment records that the person has seen the *record*; it does not clear the underlying condition: the occurrence stays `OPEN now` while the task's gate fails, and no gate, hold, review, approval, percentage or verdict is read or written by any of this (tested, "no verdict moved").

## Configuration

In Claude Code's config menu, under Cobalt Cockpit (person-only like the other alert settings):

1. `guardDigest`: on, for the one-line summary at session start. Independent of `guardAlerts`.
2. `guardAlerts` and the rest: as before.
3. Nothing to configure for the shared history: it is used when alerts have recorded something.

## Tests

`tests/alerts-shared.test.ts` (44 tests) and the updated `tests/alerts-inbox.test.ts`. Pure: key parsing (other projects, malformed, extra segments), the two bounds, `applyAcks`, `mergeHistory` against stale snapshots, interleaved writers, conflicting and repeated acknowledgments, idempotence, the cap, and forty seeded pseudo-random schedules of two sessions with stale copies in which an acknowledged occurrence is never shown as undone; the digest (counts, wording, privacy, bounds, empty states); eviction. Through the host, with a store the test can write to as another session would: the key written once with a constant value and no path; another session's acknowledgment found, marked and ending reminders; a stale session's writes leaving the key alone and the history it writes showing the acknowledgment; keys of another project or malformed ones marking nothing; `guard ack` writing a key per occurrence; a failed key write reported as session-only; the 128 bound; v0.5.7 data read and never written; a restart; project isolation; notifications off (history shown, summarised, acknowledged; nothing recorded; no project tie); the digest (off by default, once, not on reload, again for a new session, silent when all acknowledged, another project's history, a damaged marker, no notification, no process, no model call); and "no verdict moved". They are synthetic: none shows that a person saw anything, and none runs two hosts.

## Human acceptance: two concurrent Boat sessions (NOT VERIFIED until you do it)

Use one project directory and the same Claude Code configuration for both sessions. Type everything yourself.

1. Session A and session B both start in the same directory with `guardAlerts` on. In A, block a task or report a failed SECURITY gate. Expect the usual notification in A. In B run `/cockpit alerts`: expect an empty inbox or the earlier history (B started before the alert, and the task is A's; B does not see a task it does not hold).
2. In A run `/cockpit alerts ack <id>`. Expect "It is recorded for this project, so another session reads it too."
3. In B run `/cockpit alerts`. Expect the same record, if B holds it, as acknowledged. If B never held the task, expect the history entry in B only after B starts a new session in that directory; note which you saw.
4. With `guardRepeat` on and the task open in both, acknowledge in A and wait one repeat interval: B must not send a reminder for it. NOT VERIFIED until observed.
5. Interleave: acknowledge a different occurrence in B, then in A run `/cockpit alerts`: both acknowledgments show. Record an alert in each session at nearly the same moment: expect each session's own `/cockpit alerts` to be complete and the shared history possibly to hold only one session's newest records until each records something again; that is the documented limit, not a defect to report.
6. `guardDigest` on, start a third session: one line "Cobalt alerts: N unacknowledged recorded …"; reload plugins (`/reload-plugins`): no second line.
7. `guardAlerts` off, start a session: `/cockpit alerts digest` still summarises the earlier history; nothing is sent when you block a task.

## What was not observed

Two live host processes sharing a store file; the terminal rendering of the toast or the HUD row in WezTerm or Konsole; whether a person sees the toast; any behaviour across an SSH disconnect (the plugin does not observe one); the host's store behaviour in any version other than 2.1.296.
