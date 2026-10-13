# v0.6.2: Persistent Attention

> Part of the [Cobalt Cockpit documentation](README.md). Summary: [CHANGELOG](../CHANGELOG.md). The plan this implements: [roadmap-v0.6.2-persistent-attention.md](roadmap-v0.6.2-persistent-attention.md).

An acknowledgment takes an incident out of what the alert digest asks attention for. That is right for the notification and can be wrong for the condition: a security check that still fails is no less failed because someone has seen the alert about it. `/cockpit alerts digest` now ends with an **Attention** section that keeps acknowledged incidents whose condition is still demonstrably open in view, and says plainly when a condition cannot be observed from the session that draws it.

No setting, timer, process or network call was added. Alerts, their conditions, who may acknowledge, the notification rules and every security hold are as they were.

## Three facts, kept apart

| Fact | Where it lives | What it is evidence of |
|---|---|---|
| Acknowledged | the record's `acked` mark and the `alert-ack:<project>:<id>` key | a person said they received it |
| Shown | the `alert-seen:<project>` look marker | it was displayed in a look a person made |
| Condition standing | **not stored**; read now | whether the condition holds, as this session can observe it |

Nothing was added to storage. The first two are records about a person's attention; the third is computed each time from the session's current task and is never written. No stored mark can make a condition OPEN, and no acknowledgment or look can make one RESOLVED.

## What a session can observe

Alert conditions are keyed `<task uid>:<kind>:<detail>`, and what holds now is read off this session's task (`dueOf` over the task's facts). So:

| The occurrence | Standing | Why |
|---|---|---|
| its key is among the conditions that hold now for this session's task | **OPEN** | observed now |
| it belongs to this session's task (same uid and kind) and does not hold | **CLEARED** | observed not holding |
| a `resolved` record closed it | **RESOLVED** | a session that observed it said so |
| it belongs to another session, or an earlier task, or there is no task to read | **UNKNOWN** | cannot be observed from here |
| it is a release NO-GO and the release history cannot be read | **UNKNOWN** | the source is unreadable, so the kind is blind |

`standingOf` (in `hooks/alerts.ts`) is the whole rule. A task restarted with the same lineage keeps its uid, so a restart or plugin reload that carries the same task observes its conditions again; a new task, a reset or a different session does not, and its older incidents read UNKNOWN. That is conservative on purpose: UNKNOWN is never read as resolved and never as open.

Before this release `occurrencesOf` called every unresolved occurrence that did not hold in *this* session `ended`, and the inbox worded it "the condition no longer holds". For another session's incident that was a guess. With an observation the inbox and the digest now word it `condition state UNKNOWN from this session`. The occurrence model, the export (`ENDED`) and the stored records are unchanged.

## The section

```
COBALT GUARD / ATTENTION
NEW SINCE LAST LOOK: 0
STILL OPEN, ACKNOWLEDGED: 2
- HIGH: 1 review hold
- NORMAL: 1 blocked run
  9fd7cd2c HIGH review-hold · task 1 · recorded 2026-10-13 09:12Z (3h ago)
  97695672 NORMAL run-blocked · task 1 · recorded 2026-10-13 09:40Z (2h ago)
UNVERIFIED CONDITION STATE: 1
- NORMAL: 1 blocked run
  e1edce03 NORMAL run-blocked · task 2 · recorded 2026-10-12 17:03Z (19h ago)
  Raised elsewhere: not observable from here. UNKNOWN is not resolved.
ACKNOWLEDGED, NO LONGER OPEN: 1
Each incident is counted once. Acknowledging stops reminders; it does not resolve a condition.
OPEN is read from this session's task now, never from a stored record.
```

This is an illustration of the format, not output from a live incident.

- **Each incident is counted in one group**, the first that applies: *new* (not acknowledged, not shown at the last look), *not acknowledged and already shown*, *still open and acknowledged*, *unverified and acknowledged*, *acknowledged and no longer open*. The unacknowledged groups say how many of their members are open now, UNKNOWN or no longer open, so an unacknowledged incident is never hidden behind an acknowledged one, and none is counted twice.
- **Bounds.** The counts and the by-level lines are complete. Details are at most 5 per group, gravest first then newest, and the rest is said (`+N more: /cockpit alerts`). Context is the occurrence id, level, kind, task number and the recorded time: the closed vocabulary alerts already carry. The section adds no text from a record, and the history stays within the existing 32-record and per-project caps.
- **Width.** Every line is clipped to the terminal width given.
- **Without an observation** (any caller that does not pass one) the digest and the inbox read exactly as they did.
- The existing "no longer open (history)" figure now excludes UNKNOWN ones and the line adds `state UNKNOWN from this session: N` when there are any.

## Read-only

Drawing the digest reads the records, the task, the release history (only when a NO-GO was recorded, as before) and the look marker. It writes nothing: no acknowledgment, look marker, verification state or release state. The one thing it does before drawing is what it always did, `syncAcks`, which marks this session's copy of the records with acknowledgments *other* sessions already stored. It marks nothing as shown; only a person's `/cockpit alerts` look does that, as before.

## No repeated notification

Nothing in the notification path was touched. An acknowledged occurrence is excluded from reminders (`remind` returns `acknowledged`), from a first alert (`decide` returns `duplicate` or `recorded`), and from a deferred notice (`deferredOf` skips an acknowledged tail and `isSettledQuietly` stops its announcement). The tests sweep random histories and elapsed times to show that none of the three sends for an acknowledged, still-open occurrence, with quiet hours on or off. No timer was added: `hasWorkLeft` is unchanged, and the digest runs only when a person asks.

## The HUD row

The pinned GUARD row showed an unacknowledged open condition and then nothing at all once it was acknowledged, while the failed gate still held. That is the gap this milestone is about, so the row gets one minimal refinement and no redesign:

```
GUARD: ARMED · 1 acknowledged, still open · transport not confirmed · /cockpit alerts digest
GUARD: RECORDING · 1 acknowledged, still open · /cockpit alerts digest
GUARD: ARMED · 1 unacknowledged in history · 3 unverified · /cockpit alerts digest
```

It stays the row's INFO level (never the pinned warning colour), static and never animated, so reduced motion is the same row. The forms shorten with the width exactly as before, down to the bare label, and the row is the same as in v0.6.1 when nothing acknowledged is open and nothing is unverifiable. Unacknowledged history that this session cannot observe is no longer called history on the row; it is counted as `unverified`.

## Behaviours checked

| Case | Result |
|---|---|
| alerts on, record-only, alerts off with history | the section is drawn from the records in all three; with alerts off nothing new is recorded |
| quiet hours, with reminders on | an acknowledged open incident produces no notification for as long as it stays open |
| another session's acknowledged incident | UNVERIFIED, not OPEN, not resolved; no notification |
| the condition clears after the acknowledgment | leaves "still open", counted as acknowledged and no longer open |
| the condition recurs | a new occurrence (new id), counted as new; the old one stays closed |
| an acknowledgment made elsewhere while the digest is open | applied before the digest is drawn |
| the same task after a restart | observed OPEN again; nothing is told |
| older histories (no ids, no marker) and malformed ones | loaded as before; malformed records dropped, nothing believed |
| width 24 to 120 | no line wider than the width |

`tests/alerts-attention.test.ts` (32 tests) covers these, with seeded sweeps for standing, the one-group rule and the no-notification rule. Four earlier tests were updated for the two intended wording and row changes (see the CHANGELOG).

## Measurements

On the 32 occurrences a ledger can hold (the cap), in the plugin test host, mean of 2,000 runs: the Attention section 53 µs; the whole digest 49 µs with the section against 19 µs without; building the occurrences 41 µs. The only added I/O is one `get` of the release history, and only when a NO-GO has been recorded. Single-machine figures, not a benchmark.

## Limitations

- **Cross-session data.** A session holds its own task. It cannot see another session's, so an incident from there is UNKNOWN and stays so until a session that owns the task looks, or a resolution is recorded. There is no way to observe it that does not add a shared state this release does not add.
- **An earlier task of the same session** reads UNKNOWN too, even if its condition cleared when the task was replaced.
- **A condition that a different kind replaced** (a blocked run that became exhausted verification) reads CLEARED for the first key; the second is its own occurrence.
- **Export** still reports `ENDED` for what is not open; its schema is version 1 and was not changed, so it does not say UNKNOWN.
- **Look marker and acknowledgments** are as best-effort across sessions as they were; the section can over-report "new", never mark something shown that no person displayed.
- Nothing here says that a person saw anything, and none of it changes native Claude Code permissions, a security hold, a release approval or the Stop Guard.

## Acceptance (real sessions)

1. Record-only on. Block a milestone; `/cockpit alerts`, note the id; `/cockpit alerts ack <id>`. `/cockpit alerts digest` shows `STILL OPEN, ACKNOWLEDGED: 1`. The GUARD row shows `1 acknowledged, still open`. No desktop notification.
2. Unblock the milestone. The digest shows `STILL OPEN, ACKNOWLEDGED: 0` and `ACKNOWLEDGED, NO LONGER OPEN: 1`; the row's acknowledged-open text is gone.
3. Block again: `NEW SINCE LAST LOOK: 1`; the earlier incident stays closed.
4. Two sessions in one project: raise and acknowledge in the first; open the second and run the digest. The incident reads `UNVERIFIED CONDITION STATE`, not open and not resolved. Acknowledge another in the second at the same time; both appear after the next digest.
5. Restart Claude Code with the same task still blocked: the acknowledged incident reads OPEN again and nothing is notified.
6. Alerts off with history: the digest still draws the section and says nothing new is recorded.
7. Narrow the terminal to 40 columns: no line wraps and the row keeps its label.

## Review record

Filled in at delivery: [see the candidate's report](#review-record).
