# v0.6.3: Cobalt Guard Calibration

> Part of the [Cobalt Cockpit documentation](README.md). Summary: [CHANGELOG](../CHANGELOG.md). The plan this implements: [roadmap-v0.6.3-guard-calibration.md](roadmap-v0.6.3-guard-calibration.md).

Record-only mode keeps a history of incidents and tells nobody. That history shows what would have been raised; it does not show whether being told would have been welcome. Calibration lets a person say, for recorded incidents, whether they would have wanted a notification, and reports how the existing alert policy would have done against those answers.

It is an evaluation, not an automatic alert optimizer. It changes no notification delivery, no security enforcement and none of the operator's decisions. The code is `hooks/calibration.ts` (pure: labels, keys, the simulation, the figures and the wording; it is given no engine handle, so it cannot notify) and three branches of `/cockpit alerts` in `hooks/register.tsx`.

No setting, timer, process or network call was added. Alerts, their conditions, who may acknowledge, the notification rules and every security hold are as they were.

## Four facts, kept apart

| Fact | Where it lives | What it is evidence of |
|---|---|---|
| Acknowledged | the record's `acked` mark and the `alert-ack:<project>:<id>` key | a person said they received it |
| Resolved | a `resolved` record on the occurrence | a session that observed it said the condition stopped holding |
| Shown | the `alert-seen:<project>` look marker | it was displayed in a look a person made |
| Labelled | the `alert-label:<project>:<id>` key | what a person, looking back, says they would have wanted |

Acknowledgment, resolution and the label are separate facts, and no operation on one changes another. An acknowledged incident may be labelled NOISE; a resolved one may be labelled NOTIFY; an unlabelled one is unreviewed. Labelling acknowledges nothing, resolves nothing, sends nothing and changes no setting, gate, hold, review, approval or verdict.

## The commands

- **`/cockpit alerts review [page]`** lists the recorded incidents, unreviewed first (gravest kind first, then the latest recorded), eight to a page. Each line has the id, level, kind, task, recorded time, whether it is acknowledged, the condition state and the label if there is one. Read-only, any origin.
- **`/cockpit alerts label <id> notify|record|noise|clear`** sets or removes a label. `notify` is NOTIFY (I would have wanted a notification), `record` is RECORD_ONLY (worth recording, not worth interrupting me), `noise` is NOISE (not useful as an incident), `clear` removes the label. Accepted only from a person, below.
- **`/cockpit alerts calibration`** prints the report. Read-only, any origin, sends nothing.

A review line:

```
  486bf3dd CRITICAL security-failure · task 3 · recorded 2026-10-12 14:03Z (12m ago) · not acknowledged · condition state UNKNOWN from this session · labelled NOTIFY
```

This is an illustration of the format, not output from a live incident.

**Review is not a look.** It writes no `alert-seen` marker, so `SINCE LAST LOOK` is unchanged. It takes up no acknowledgment: acknowledgments other sessions stored are applied to the session's copy in memory only.

## Who may label

A label is accepted from human authority only, the same rule as acknowledgment: the terminal's own Enter (`composer`) or the Remote Control bridge (`bridge`). These are refused before anything is read or written:

- `sdk`, which is every `claude -p` and Agent SDK turn, because the host cannot attribute those to a person;
- a model, a subagent, a plugin or a hook;
- an origin kind a later host adds.

The reply is `Cockpit: an alert is labelled only by a command you type; nothing was changed.` The progress tool has no label action. An unknown, expired or malformed id is refused with nothing written. Setting the label an occurrence already has writes nothing.

## Storage and multi-session safety

One plugin-store key per labelled occurrence:

```
alert-label:<12-hex project hash>:<8-hex occurrence id>
{ "v": 1, "label": "NOTIFY" | "RECORD_ONLY" | "NOISE", "at": <milliseconds> }
```

Nothing else is stored: there is no field for a path, prompt, command, customer data or free text.

- **Written whole.** A label is one `set`, removing it is one `delete`, and a stored label is never read and written back.
- **Two sessions.** The host serialises each `set` and `delete` (the analysis is in [cobalt-guard.md](cobalt-guard.md#shared-history-the-digest-and-notifications-off-v058)), so two sessions labelling different occurrences cannot lose each other's labels. On one occurrence the later label stands.
- **Kept apart** from `alert-occ:` (the occurrence's records) and `alert-ack:` (the acknowledgment).
- **Bounded** by the occurrences that are still held: label keys are created only by the label command, and every accepted label command removes the orphans, so between two of them a label whose occurrence has gone can remain, counted nowhere.
- **Orphans.** A label whose occurrence is gone is counted nowhere. Its key is deleted the next time a person sets or removes any label, in any session, and only if all of these hold: the store lists no `alert-occ` key for it; that session does not read the occurrence; no session's persisted records (`ledger:<session>`, the last eight sessions) of that project hold it; and no earlier-format history key of that project (`alert-history:<project>`, or the v0.5.7 `alert-history`) holds it. A read that fails keeps the labels of every project in question, and an earlier-format history that is not understood keeps the labels of its project; a session record that is not of this build's shape holds nothing (its session writes it again at its next persist). The key list is read twice and only what is orphaned both times is deleted. Review and calibration never delete. Another session's label on an occurrence that the store or a session still holds is therefore never removed, including one whose key another session pruned at the bound while a session that holds it will write it again.
- **A label value this build cannot read** is counted as unreviewed and said so: review says `its stored label could not be read`, and the report says `N stored label(s) could not be read`. A new label replaces it and `clear` removes it; the sweep never deletes it while its occurrence exists.
- **A key that is not exactly a label key** is ignored and never deleted.
- **Earlier histories** load unchanged. An occurrence recorded before v0.6.3 is unreviewed until it is labelled.

## The observed set

The project's bounded history as the store holds it when the command runs (`alert-occ:<project>:*`, at most the newest 32 read), joined in memory with the session's own records, each occurrence once. Two sessions therefore report over the same set. When the session's records are tied to no project yet, the project is the hash of the working directory, computed in memory: nothing is tied or written by it.

An event Cockpit never recorded is in no figure. The report says so.

## The simulation

Each occurrence is put through the live policy's own decision functions, `decide` and `holdOf` (in `hooks/alerts.ts`), called in the order the live alert pass calls them. There is no second implementation of the policy. They run on a frozen copy of the configuration built from the options with `guardAlerts` true: recording may be on while alerts are off, and the question is what alerts would have done. The real configuration is never written, and `guardAlerts` stays as the operator set it.

Evaluated, for each occurrence on its own, at the moment it was first recorded:

- the notified kinds (`guardNotifyKinds`; `security-failure` is always notified);
- quiet hours (`guardQuietHours`, `guardQuietTimezone`, `guardQuietOrdinary`, `guardQuietCritical`);
- critical versus ordinary.

Not simulated, and named in the report: the cooldown between alerts, the alert budget of a session, reminders, a silence, a notification that failed to send and its retries, and whether a deferred alert was told after quiet hours ended. No notification, sound, bell, timer or alert budget is touched. Settings that are not understood are shown as `WARN` lines and, as in the live policy, never cause deferral (quiet hours `NOT IN FORCE`).

## The report

```
GUARD CALIBRATION · simulated, nothing sent · 14 recorded · 11 reviewed · 3 unreviewed
Observed: the incidents in this project's bounded history. An event Cockpit never recorded is in no figure here.
Simulated policy · notifications are treated as on for this report only; guardAlerts is off (recording only) and was not changed:
  notified kinds: security-failure, release-no-go · NOT notified: verification-exhausted, review-hold, run-blocked (guardNotifyKinds)
  quiet hours: 00:00-00:30 UTC (guardQuietTimezone) · in the window ordinary alerts are deferred and critical alerts are sent
All 14 recorded, by simulated outcome: would notify 6 · would defer for quiet hours 0 · would not notify 8
Reviewed 11 · your label against the simulated outcome:
  wanted, would notify: 3
  not wanted, would notify (an unwanted notification): 3
  wanted, would not notify (a missed wanted notification): 2
  not wanted, would not notify: 3
  deferred for quiet hours: 0 (wanted 0 · not wanted 0) · in neither rate; whether one was told afterwards is not simulated
  labelled NOISE: 3 · judged not useful as an incident: counted above as not wanted, and also a judgement about what is recorded, not only about notifying
Unreviewed 3 · in no figure below, and not assumed to be any label.
Simulated notification precision: INSUFFICIENT EVIDENCE · 3 wanted of 6 reviewed incidents the policy would notify · a rate needs at least 10
Missed-wanted share: INSUFFICIENT EVIDENCE · 2 not notified of 5 reviewed incidents labelled NOTIFY, deferred ones apart · a rate needs at least 10
  The missed-wanted share is a share of recorded, reviewed incidents. Cockpit cannot measure the incidents it never recorded.
  INSUFFICIENT EVIDENCE means too few labelled incidents for a rate. It is not a finding about the policy.
By kind:
  CRITICAL security-failure · 3 recorded · NOTIFY 1 · RECORD_ONLY 1 · NOISE 1 · unreviewed 0 · would notify 3 · defer 0 · not notify 0
  ...
```

This is an illustration of the format, not output from a live incident. Besides the figures the report gives every recorded incident by simulated outcome and a by-kind table.

### Definitions

| Term | Meaning |
|---|---|
| wanted | labelled NOTIFY, and the policy would notify |
| unwanted | labelled RECORD_ONLY or NOISE, and the policy would notify |
| missed | labelled NOTIFY, and the policy would not notify |
| deferred | the policy would hold it for quiet hours; its own row, with its wanted and not-wanted split, in neither rate |
| NOISE count | reported apart, as a statement about what is recorded; a NOISE label is also not wanted, so it is counted in the cells above like RECORD_ONLY |
| unreviewed | in no cell, and never assumed to be any label |
| Simulated notification precision | wanted ÷ (wanted + unwanted) |
| Missed-wanted share | missed ÷ (wanted + missed): of reviewed NOTIFY incidents with a settled outcome, deferred ones apart |

### Rules

- **A rate needs a denominator of at least 10 labelled incidents.** Below that the report shows the counts and `INSUFFICIENT EVIDENCE`. That is not a finding about the policy: it says there are too few labels for a rate, and a history of at most 32 incidents will often be there.
- **From 10, the rate comes with its interval**: the 95% Wilson score interval, with the counts and the denominator in words beside it. For example: `Simulated notification precision: 66.7% (95% Wilson interval 39.1% to 86.2%) · 8 wanted of 12 reviewed incidents the policy would notify`.
- **The missed-wanted share is not detection recall.** Cockpit cannot evaluate incidents it never recorded, and the report says so wherever the figure appears and uses no other name for it.

## Read-only and silent

Review and calibration read the store and the session's records and write nothing: no label, acknowledgment, look marker, setting or verification state, and no orphan deletion. Only `label` writes, and only the one key, plus the orphan sweep described above. Nothing is sent: no notification, sound, bell or reminder, and the simulation consumes none of a real session's cooldown, budget or reminder state. The report recommends no setting, offers no action and changes nothing.

## Critical security alerts

`security-failure` is simulated as the live policy treats it: always a notified kind, governed by the critical quiet-hours setting. The operator may label a critical occurrence however they judge it, and the report shows that. Nothing in the report is a reason to switch off critical security notifications, an option that does not exist.

## Departures from the proposal

The plan is [roadmap-v0.6.3-guard-calibration.md](roadmap-v0.6.3-guard-calibration.md). Where this build differs:

1. **Deferred notifications are excluded from the missed-wanted denominator.** The proposal's sentence had them in it. Counting them in the denominator but not in the numerator would imply they were delivered.
2. **How many deferred alerts would still have been told after the window is not given.** It cannot be reconstructed: no record says when a condition stopped holding, and telling it needs a running session, budget left and no acknowledgment in between.
3. **No reason is printed per incident.** The proposal has a result of "would not notify, with the reason". The only reason the simulation can give is that the kind is not notified (or, for a configuration with notifications off, that they are off), so the report gives it per kind (the by-kind table and the notified kinds above it) rather than per incident.
4. **NOISE is worded "not useful as an incident".** The proposal says "not worth writing down as an incident". The meaning is the same; the wording is the operator's own, as the mission states it.
5. **The proposal's open questions are settled.** Review is not a look. The export does not gain labels and stays at schema version 2. Orphaned labels are removed lazily by the next accepted label command in any session, under the rule above. The threshold is 10 and the interval is the 95% Wilson score interval.

## Limitations

- **Another session's incident.** Review can list an incident another session recorded after this session started. This session's inbox and `alerts ack` do not know it until the session restarts, and review shows it as `condition state UNKNOWN from this session`.
- **Recorded incidents only.** Every figure is about incidents Cockpit recorded and a person reviewed. Nothing measures what it never recorded.
- **Part of the policy.** The cooldown, the session budget, reminders, silence, send failures and the telling of a deferred alert are not simulated, so a figure never covers more than the notified kinds, quiet hours and the level.
- **Small samples.** The history holds at most 32 incidents per project, so a rate is often `INSUFFICIENT EVIDENCE`.
- **A label is a judgement made later.** It records what the person says now, not what they felt at the time, and the report does not treat it as more.
- **Export.** `/cockpit alerts export` is unchanged: schema version 2, no labels.
- Nothing here says that a person saw anything, and none of it changes native Claude Code permissions, a security hold, a release approval or the Stop Guard.

## Tests

`tests/alerts-calibration.test.ts` (54 tests) covers the pure module: the vocabulary and the keys, the stored value's closed shape, the orphan rule, earlier-format histories and sessions' persisted records, the observed set, the frozen configuration, the simulation against `decide` and `holdOf`, quiet hours across midnight and in a named zone through daylight saving, settings that are not understood, the Wilson interval and the threshold, the cells and their sums, and the wording of the report and the review list. `tests/alerts-labels.test.ts` (90) covers the commands: the refusal of every origin but the composer and the bridge (look-alike kinds, a getter, arguments that name an origin), the lifecycle of a label, its independence from acknowledgment, resolution and the look marker, read-only behaviour from any origin, no notification, sound, reminder or guard-state change, the options untouched, and the simulated outcomes following the configuration. `tests/alerts-labels-shared.test.ts` (42) covers two sessions, orphan cleanup (including a label whose occurrence's key another session pruned while a session still holds it), earlier-format histories, corrupt values, failed writes, stale ids, privacy, the export, and agreement with the live alert pass. Seeded sweeps check the orphan rule, the simulation and the sums, and an interleaving of two sessions.

Eight deliberate defects were put into a copy of the code, one at a time, to check that these tests notice them: a label accepted from `sdk`, quiet hours ignored by the simulation, the sweep deleting a label whose occurrence exists, the sweep ignoring what sessions still hold, deferred incidents counted as missed, a threshold of five, a review that writes the look marker, and a simulation that keeps `guardAlerts` off. Each made between 1 and 29 tests fail. `scripts/acceptance-harness.sh` adds eight checks with two genuine host processes.

## Measurements

Single-machine figures, not a benchmark.

- **Pure, in the plugin test host** (64 occurrences: the 32 a session can hold and 32 more stored by others; quiet hours read in `Europe/Berlin`; mean of 2,000 runs): the figures (`calibrationOf`) 0.73 to 0.91 ms, almost all of it the live policy's own wall-clock reading of the zone, which it does for every alert; the report's text 8 to 11 µs; one page of the review 23 to 34 µs; the frozen configuration 110 to 124 µs. One simulated decision without a zone to read: under 1 µs.
- **Commands, in the plugin test host,** on a store at its bound (four projects of 32 occurrences, a label on each, 20 orphaned labels in this project, and eight sessions' persisted records of about 90 KB each; mean of 200 runs): `review` 6.0 to 6.6 ms, `calibration` 4.3 to 4.8 ms, against about 0.4 ms for the inbox, which reads only the session's own records. `review` and `calibration` wrote nothing. The first label command wrote its one key and deleted the 20 orphans in 29 ms, the eight session records included; the next wrote one key and deleted nothing in 14 ms. Afterwards the store held 128 label keys for 128 occurrence keys and no orphan.
- **Store reads per command:** one key listing, one read for each occurrence key of the project that the session does not hold (at most 32), and one read for each label key of an observed occurrence (at most one per occurrence). A label command adds one write; its sweep adds one key listing, and only when there is an orphan candidate a second listing, one read per persisted session record (at most eight), one per earlier-format history key, and one delete per orphan.
- **Genuine host processes** (Claude Code 2.1.299, `claude -p`, a disposable store holding 32 occurrences and 32 labels, five runs each): `/cockpit alerts calibration` 734 to 805 ms, `/cockpit alerts review` 729 to 760 ms, `/cockpit alerts` 719 to 757 ms, `/cockpit version` 749 to 789 ms. The process start dominates; the commands are within its noise. The runs left the occurrence and label keys as they were and wrote no look marker.
- **Bounds.** The history bounds are unchanged (32 occurrences per project, four projects). Label keys are created only by the label command, which removes orphans as it goes, so they are bounded by the occurrences; the review and the report read at most 32 stored occurrences beyond the session's own.

## Acceptance (real sessions)

`scripts/acceptance-interactive.sh` builds a disposable place to try exactly the committed candidate in two real Claude Code sessions on one test project, as for v0.6.2. It starts nothing for you, labels nothing and confirms nothing on your behalf. The installed user-scope plugin and your own configuration are neither read nor written: the sessions run with their own `CLAUDE_CONFIG_DIR` and `HOME`, so the candidate is the only Cockpit that loads. No credential is copied; you sign in once inside the disposable configuration. A session reads its options when it starts, so a profile is chosen at launch:

| Profile | Options for that launch |
| --- | --- |
| `record` (default) | `guardRecordOnly` on, `guardAlerts` off |
| `kinds` | as `record`, with `guardNotifyKinds` `none` (only `security-failure` notified) |
| `quiet` | as `record`, with quiet hours `00:00-23:59` in `UTC`: ordinary alerts are deferred at every minute of the day but 23:59, where the window ends |
| `alerts` | the v0.6.2 settings: alerts on, reminders every 60 s, a 30 s cooldown |

```sh
scripts/acceptance-interactive.sh setup                       # needs a clean tree; prints DIR
scripts/acceptance-interactive.sh verify DIR                  # no model, no login: version 0.6.3, the source under DIR, strict validation
scripts/acceptance-interactive.sh launch DIR 1                # terminal 1, profile record
scripts/acceptance-interactive.sh launch DIR 2 [profile]      # terminal 2, when told below
CONTINUE=1 scripts/acceptance-interactive.sh launch DIR 1 [profile]   # session 1 again
scripts/acceptance-interactive.sh sdk DIR alerts label <id> notify    # one claude -p run: the sdk origin, not a person
scripts/acceptance-interactive.sh clean DIR
```

Record what you see at each step; where the text says *expect*, a different result is a finding.

1. **Session 1, record (profile `record`).** Ask Claude: *use the cobalt-cockpit progress tool to plan three milestones (Inspect, Implement, Verify), block m1 with the note "needs the owner", report the SECURITY gate as fail with evidence "acceptance", then unblock m1 and block it again four times*. Expect no notification, sound or bell at any point, `/cockpit guard` to read `GUARD: RECORDING`, and `/cockpit alerts` to list the incidents as `RECORDED only, no notification`: a CRITICAL `security-failure` and several NORMAL `run-blocked` occurrences, each with its own id. For a rate in step 6 you need at least ten labelled incidents in a denominator: repeat the unblock and block, or fail the SECURITY gate again after passing it, until the inbox lists twelve or more.
2. **Review is not a look.** Run `/cockpit alerts digest` and note the `SINCE LAST LOOK` line. Run `/cockpit alerts review`: expect every incident under `UNREVIEWED`, gravest first. Run `/cockpit alerts digest` again: expect the same `SINCE LAST LOOK` line.
3. **Label, change, clear.** `/cockpit alerts label <id> notify` on one incident: expect `is labelled NOTIFY`, and `labelled NOTIFY` on its line in `/cockpit alerts review`. `/cockpit alerts label <id> noise`: expect `It was NOTIFY.` `/cockpit alerts label <id> clear`: expect `it is unreviewed again`. Label it again (any label). Expect `/cockpit alerts` to show it `not acknowledged` throughout: a label does not acknowledge.
4. **Labels and acknowledgments stay apart.** `/cockpit alerts ack <id>` on a labelled incident: expect its label unchanged in `review`. Clear that label: expect `/cockpit alerts` to show it still acknowledged.
5. **Not a person (third terminal).** `scripts/acceptance-interactive.sh sdk DIR alerts label <id> notify` on an incident with another label: expect `an alert is labelled only by a command you type; nothing was changed`, and that label unchanged in session 1's `review`. You may also ask Claude in session 1 to set a label in any way it can: expect it to have no way that works, and nothing to change.
6. **The report.** `/cockpit alerts calibration` with fewer than ten labels in a denominator: expect the counts and `INSUFFICIENT EVIDENCE`, no percentage, a `Not simulated:` line, `simulated, nothing sent`, and no use of the word recall. Label more incidents (at least ten NOTIFY or ten that the policy would notify) and read it again: expect a percentage with `95% Wilson interval` and the counts in words beside it, and the unreviewed count lower.
7. **Session 2, the same history.** Launch session 2 (profile `record`). `/cockpit alerts review` and `/cockpit alerts calibration`: expect the same incidents, labels and counts as session 1. Label two different incidents at about the same time, one in each session: expect both labels in both sessions' `review`. Then label one incident `notify` in session 1 and `record` in session 2: expect the later one in both sessions' `review`.
8. **Another configuration.** Exit session 2 and launch it with profile `kinds`: expect `calibration` to name `security-failure` as the only notified kind, the `run-blocked` incidents under `would not notify`, the `security-failure` ones still `would notify`, and `guardAlerts is off (recording only) and was not changed`. Relaunch it with profile `quiet`: expect the `run-blocked` incidents (unless one was recorded in the minute 23:59 UTC) under `would defer for quiet hours`, in neither rate, and `security-failure` still `would notify`. `/cockpit guard` reads `GUARD: RECORDING` in both.
9. **Nothing is sent.** Relaunch session 2 with profile `alerts` and run `review`, a `label` and `calibration`: expect no notification, sound or bell from any of them, and `/cockpit guard` to show `0 of 5 alerts used this session`. (A new incident in that session would be notified as usual; the recorded ones are not announced.)
10. **Clean up.** `scripts/acceptance-interactive.sh clean DIR`.

What this shows and does not: the records, the labels you set, the simulated figures, and your own observation that nothing was sent. It does not show that anyone read a notification, and nothing in the candidate claims it.

## Review record

**First round, on `a264f2a`.** Three independent reviews, each in a fresh context with its own scope: security and side effects; correctness, concurrency and the statistics; scope, documentation and release hygiene. All three returned GO. What they found, and what was done:

- **Minor, raised by two reviewers independently:** the orphan sweep could delete the label of an occurrence whose key another session had pruned at the bound while a session that still held it would write it again. Corrected in `e24910c`: a label is also kept while any session's persisted records of its project hold the occurrence; regression tests reproduce the case.
- **Minor, documentation:** the `quiet` profile's window does not cover the minute 23:59; two departures from the proposal were not listed (no per-incident reason, the NOISE wording). Corrected.
- **Minor, evidence:** the first harness run predated the version commit. The harness is run again on the final candidate.
- **Notes:** the report now says that a NOISE label also counts as not wanted in the cells; the look-alike origin test asserts its refusal unconditionally and that the kind is read once; the configuration guidance is worded as a procedure; the bound of label keys is stated with the lazy sweep. Kept as designed, and said here: `review` and `calibration` answer any origin, as the inbox and the digest do (only labelling, like acknowledging, is a person's); the observed set can briefly hold more than 32 stored occurrences between two prunes.

**The final candidate** is reviewed again before delivery; that verdict is in the delivery report, not in this file, so that the file does not change the commit it describes.
