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
- The section's `NEW SINCE LAST LOOK` counts unacknowledged incidents only and says so; the existing `SINCE LAST LOOK` summary above it counts every unseen one, acknowledged or not, and with an observation it splits `history` from `state UNKNOWN`. Narrow widths pick a shorter form of each qualifier or disclaimer (`(unacked)`, `UNKNOWN ≠ resolved`) rather than cutting it.
- **Without an observation** (any caller that does not pass one) the digest and the inbox read exactly as they did.
- The existing "no longer open (history)" figure now excludes UNKNOWN ones and the line adds `state UNKNOWN from this session: N` when there are any.

## Who may record a resolution

Alerts already recorded a condition `resolved` on a pass once it no longer held, and a session's ledger holds the project's earlier records. A pass in a second session would therefore have written `resolved` onto the first session's still-open incident, only because the second session's own task does not have it, and that stored mark would then read as a real resolution. v0.6.2 limits the pass: it records a condition resolved only for a task this process has itself held (the current task, and any earlier task it saw in this run). Another session's incidents, and ones left from before this process started, are left alone and read UNKNOWN. The same pass no longer records a release NO-GO resolved when the release history cannot be read (it is read once, strictly; a value that is not a list counts as unreadable). The reminder timer likewise looks only at records of tasks this process holds (and ignores a NO-GO whose history is unreadable), so it does not poll for records it can never act on. The release records are read once per pass and the same read decides both what is open and whether a NO-GO may be closed. Ownership is per process run and is cleared when a session starts.

The consequence is deliberate and visible: a stored record of a task nobody here holds is no longer closed on the first look. It stays in the history, is never notified (as before), and is shown as UNKNOWN until a session that owns it resolves it or it ages out of the bounded history. Two earlier tests (`tests/alerts-persistent.test.ts`, `tests/alerts-quiet.test.ts`) asserted the old closing and now assert this.

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

`tests/alerts-attention.test.ts` (40 tests) covers these, with seeded sweeps for standing, the one-group rule and the no-notification rule, and cases for another session's pass, an unreadable release history, and the acknowledgment reply. Six earlier tests were updated for the intended wording, row and resolution changes (see the CHANGELOG).

## Measurements

On the 32 occurrences a ledger can hold (the cap), in the plugin test host, mean of 2,000 runs: the Attention section 53 µs; the whole digest 49 µs with the section against 19 µs without; building the occurrences 41 µs. The only added I/O is one `get` of the release history, and only when a NO-GO has been recorded. Single-machine figures, not a benchmark.

## Limitations

- **Cross-session data.** A session holds its own task. It cannot see another session's, so an incident from there is UNKNOWN and stays so until a session that owns the task looks, or a resolution is recorded. There is no way to observe it that does not add a shared state this release does not add.
- **An earlier task of the same session** reads UNKNOWN too, even if its condition cleared when the task was replaced.
- **A condition that a different kind replaced** (a blocked run that became exhausted verification) reads CLEARED for the first key; the second is its own occurrence.
- **The GUARD label** (`SENT`/`FAILED`) is computed from the records alone. A sent, unacknowledged notice of a task this process no longer holds is no longer closed by a pass, so the label can keep saying `SENT` (a true statement: it was sent and nobody acknowledged it) where v0.6.1 returned to `ARMED` after closing it. Acknowledging it clears the label.
- **Resolution marks written before this release** by a session that could not observe the condition cannot be told from true ones; they read RESOLVED.
- **Export** is schema version 2: `condition` is `OPEN`, `RESOLVED`, `ENDED` or `UNKNOWN`. `ENDED` keeps its meaning but is said only where this session's own task was observed not holding it; a condition it cannot observe is `UNKNOWN`, never `ENDED`. Version 1 said `ENDED` for both. With no observation given, nothing is called `ENDED` or `OPEN`. A consumer pinned to version 1 sees a new `version` value and one new word; it never sees a false `ENDED`.
- **Look marker and acknowledgments** are as best-effort across sessions as they were; the section can over-report "new", never mark something shown that no person displayed.
- Nothing here says that a person saw anything, and none of it changes native Claude Code permissions, a security hold, a release approval or the Stop Guard.

## Acceptance (real sessions)

`scripts/acceptance-interactive.sh` builds a disposable place to try exactly the committed candidate in two real Claude Code sessions on one test project. It starts nothing for you, simulates no acknowledgment and confirms nothing on your behalf. The installed user-scope plugin and your own configuration are neither read nor written: the sessions run with their own `CLAUDE_CONFIG_DIR` and `HOME`, so the candidate is the only Cockpit that loads. No credential is copied; you sign in once inside the disposable configuration.

```sh
scripts/acceptance-interactive.sh setup                  # needs a clean tree; prints DIR
scripts/acceptance-interactive.sh verify DIR             # no model, no login: loaded version and path, strict validation
scripts/acceptance-interactive.sh launch DIR 1           # terminal 1
scripts/acceptance-interactive.sh launch DIR 2           # terminal 2, when told below
CONTINUE=1 scripts/acceptance-interactive.sh launch DIR 1   # session 1 again after a restart
scripts/acceptance-interactive.sh clean DIR
```

The options for these launches are alerts on, `guardRepeat` on at 60 s, a 30 s cooldown and 3 reminders at most, so a repeated notification would show within a few minutes. The first launch shows Claude Code's first-run screens (theme, sign-in, folder trust) once; both sessions share the result. `COBALT_ACCEPT_PASS_AUTH=1` passes `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from your environment instead of a sign-in.

Record what you see at each step; where the text below says *expect*, a different result is a finding.

1. **Session 1, record.** Ask Claude: *use the cobalt-cockpit progress tool to plan three milestones (Inspect, Implement, Verify), then block milestone m1 with the note "needs the owner"*. Expect one terminal notification (a NORMAL blocked-run alert) and a GUARD row that names it. `/cockpit alerts` lists it with an 8-character id.
2. **Session 1, acknowledge (you).** Type `/cockpit alerts ack <id>`. Expect the reply to say the condition is still open and that no more reminders will be sent, and the GUARD row to read `1 acknowledged, still open`. `/cockpit alerts digest` ends with `STILL OPEN, ACKNOWLEDGED: 1` and `- NORMAL: 1 blocked run`.
3. **Session 1, no repeat.** Wait four minutes without unblocking. Expect no further notification, and the row and digest unchanged. (Without the acknowledgment a reminder would come about every minute, three at most.)
4. **Session 2, cannot observe.** Start session 2 and run `/cockpit alerts digest`. Expect `UNVERIFIED CONDITION STATE: 1` with `UNKNOWN is not resolved`, `STILL OPEN, ACKNOWLEDGED: 0` and no `NO LONGER OPEN`; no notification from session 2. `/cockpit alerts export` should show `"version": 2` and `"condition": "UNKNOWN"` for it. Do not acknowledge or unblock anything in session 2.
5. **Session 1, resolution.** Ask Claude to unblock m1 with the progress tool. Expect the row's acknowledged-open text to go and the digest to show `STILL OPEN, ACKNOWLEDGED: 0` and `ACKNOWLEDGED, NO LONGER OPEN: 1`. No notification.
6. **Session 1, recurrence.** Ask Claude to block m1 again. Expect a new occurrence with a new id (`NEW SINCE LAST LOOK: 1 (unacknowledged only)`), a notification for it (it is new, not a repeat), and the earlier one still counted as closed.
7. **Restart.** Exit session 1 and launch it again with `CONTINUE=1`. Expect the history kept. The first incident (acknowledged in step 2, unblocked in step 5) stays acknowledged and closed, and is not notified again. The step 6 incident is not acknowledged and is open, so a reminder for it is expected and is not a finding; acknowledge it (`/cockpit alerts ack <id>`) and, with the block still in place, expect no further notification, and its condition to read OPEN if the task came back with the session and UNKNOWN if it did not, never RESOLVED or NO LONGER OPEN. A session 2 started afresh afterwards should find the resolution session 1 recorded in step 5 and count the first incident as closed.
8. **Narrow terminal.** Make a terminal about 40 columns wide and run `/cockpit alerts digest` in either session. Expect no wrapped line, the words `unacked` and `UNKNOWN is not resolved` (or `UNKNOWN ≠ resolved`) intact, and a GUARD row that keeps its label.

What this shows and does not: the records, the host's report that it wrote a notification, and your own observation. It does not show that anyone read a notification, and nothing in the candidate claims it.

## Review record

Filled in at delivery: [see the candidate's report](#review-record).
