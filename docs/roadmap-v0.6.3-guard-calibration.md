# Proposed for v0.6.3: Cobalt Guard Calibration

Status: implemented in v0.6.3 on a candidate branch, pending the owner's approval to merge. What was built, and where it departs from this proposal, is in [implementation-v0.6.3.md](implementation-v0.6.3.md). Nothing here widened the scope of v0.6.1 or of [v0.6.2 Persistent Attention](roadmap-v0.6.2-persistent-attention.md).

## Purpose

Give the operator evidence about notification quality before deciding whether to turn alerts on, using the incident history that record-only mode already keeps ([cobalt-guard.md](cobalt-guard.md#record-only-mode-and-since-your-last-look-v059)).

With `guardRecordOnly` on and `guardAlerts` off, Cockpit writes incidents down and tells nobody. That history shows what would have been raised. It does not show whether being told would have been welcome. Calibration adds the missing half: a person says, for incidents that were recorded, whether they would have wanted a notification, and Cockpit reports how the existing alert policy would have done against those answers.

It changes nothing about what is blocked, held or enforced. It is evidence for one decision, and that decision stays the operator's.

## What it must never do

- Turn alerts on, or change any alert setting.
- Change security enforcement, clear a hold, pass or fail a gate, or approve a release.
- Send, play or ring anything. The policy is simulated; no notification leaves.
- Weaken the special treatment of critical security notifications. `security-failure` cannot be switched off when alerting is enabled, and no calibration result can be read as a reason to switch it off.
- Present a figure about recorded incidents as a figure about incidents Cockpit never recorded.

## Three labels on an incident, kept apart

An occurrence can carry three independent facts, and calibration adds only the third:

1. **Acknowledged**: a person said they received the alert (`alert-ack:<project>:<id>`, as today).
2. **Resolved**: the condition stopped holding (in the occurrence's own record, as today).
3. **Notification preference**: what the person, looking back, would have wanted for this occurrence.

Setting one never sets, clears or implies another. An acknowledged incident may be labelled NOISE; a resolved one may be labelled NOTIFY; an unlabelled one is simply unreviewed.

## Classification

Three values, chosen by a person for one occurrence:

| Label | Meaning |
|---|---|
| `NOTIFY` | I would have wanted to be told about this when it happened. |
| `RECORD_ONLY` | Worth writing down; not worth interrupting me. |
| `NOISE` | Not worth writing down as an incident. |

**Workflow.**

1. The operator asks for the occurrences that have no label (a bounded page, gravest first, with the same fields the inbox shows: level, kind, task, when it was recorded, whether its condition holds now).
2. The operator labels one occurrence at a time by its id. A label can be changed or removed.
3. Labelling is accepted only when typed by a person, like acknowledgment, silence and the alert export. A model, a subagent or a headless origin is refused, and the refusal changes nothing.
4. Labelling does not acknowledge, does not resolve, and sends nothing. Whether showing the unlabelled list counts as a "look" for the since-last-look summary is a design decision; the proposal is that it does not.

`NOISE` does not delete the record and does not stop that kind of incident being recorded. It is an answer to a question, not an instruction.

## Proposed storage model

- **One key per label**: `alert-label:<project>:<id>`, holding the label and the time it was set, nothing else. `<project>` is the existing 12-hex hash of the working directory and `<id>` the existing occurrence id. No path, prompt, command or free text is stored.
- **Written whole, never read back and rewritten.** A label is one `set` of one key, and removing it is one `delete`. The host serialises each of those, so two sessions labelling different occurrences cannot lose each other's labels, and two sessions labelling the same occurrence leave the later one, which is the intended meaning of changing a label. No shared list is merged.
- **Separate from the occurrence and the acknowledgment.** The label is not a field of `alert-occ:` and never touches `alert-ack:`. A write to one cannot disturb the others.
- **Bounded by the existing history.** Labels exist only for occurrences inside the present bounds (32 occurrences per project, four projects). When an occurrence expires, its label goes with it, and a label whose occurrence is gone is counted nowhere. The number of label keys is therefore bounded by the number of occurrences.
- **Nothing derived is stored.** The simulation and the report are computed when asked for and kept nowhere.
- **Earlier histories** load unchanged; an occurrence recorded before this milestone is unreviewed until someone labels it.

To settle in design: whether the alert export gains the labels (a schema change), and how an orphaned label is removed where the session that expires an occurrence is not the one that labelled it.

## Evaluation methodology

**The observed set.** The occurrences in this project's bounded history. Nothing else is in scope, and the report says how many there are.

**Simulation.** Each occurrence is put through the existing alert policy as it is configured, by the same decision code the live path uses, not a second implementation of it: the fixed priority of its kind, `guardNotifyKinds`, and quiet hours (`guardQuietHours`, `guardQuietTimezone`, and what the ordinary and critical classes do inside the window). The result for each is one of: would notify; would defer (and whether it would still have been told when the window ended); would not notify, with the reason. No notification, sound or bell is produced, and no cooldown, budget or reminder state of a real session is consumed.

Some of the live decision depends on a session's state at the time (the cooldown since the last alert, the session's alert budget, reminders). Design must establish which of those can be reconstructed from the stored history and which cannot. Whatever is not simulated is named in the report next to the figures, so a result is never read as covering more of the policy than it did.

**Definitions.** For a reviewed occurrence, against the simulated policy:

| | Labelled `NOTIFY` | Labelled `RECORD_ONLY` or `NOISE` |
|---|---|---|
| Policy would notify | true positive | **false positive**: an unwanted notification |
| Policy would not notify | **false negative**: a missed wanted notification | true negative |

- **Simulated notification precision** = true positives ÷ all reviewed occurrences the policy would notify.
- **Missed wanted notifications** = the false negatives, as a count and as a share of all reviewed occurrences labelled `NOTIFY`.
- A deferred notification is reported in its own row, not folded into either column, with how many of those would still have been told after the window.
- `NOISE` is also reported on its own, as recorded incidents the operator judged not worth recording: that is a statement about what is recorded, not about notification.

**What the second figure is not.** It is a share of the wanted notifications *among incidents Cockpit recorded and a person reviewed*. It is not detection recall. An event that Cockpit never recorded is in no row of this table, and nothing here measures how many such events there were. The report says so wherever the figure appears, and does not use the bare word "recall" for it.

**Sample size and unreviewed counts.** Every figure is shown with the counts behind it: occurrences observed, reviewed, unreviewed, and the four cells. Unreviewed occurrences are never assumed to be any label.

**Insufficient evidence is not poor performance.** Below a minimum number of reviewed occurrences in the relevant cells, the report shows the counts and the words `INSUFFICIENT EVIDENCE` in place of a rate. With enough, it shows the rate with an interval that reflects the sample, not a bare percentage. The threshold and the interval method are design decisions and are stated in the report. A history bounded at 32 occurrences per project will often be on the insufficient side, and the report must say that plainly instead of rounding a handful of cases into a verdict.

**Critical incidents.** `security-failure` is simulated as the live policy treats it: always a notified kind, and governed by the critical quiet-hours setting. The operator may label a critical occurrence however they judge it, and the report shows that. The report makes no suggestion that depends on switching critical notifications off, because that option does not exist.

## The decision stays with the operator

The report ends with what was measured and what was not. It does not recommend a setting, offers no "enable now" action, and changes nothing. Turning `guardAlerts` on, or changing the notified kinds or quiet hours, remains what it is today: something only the operator does, in the config menu.

## Preserved as they are

- The per-project history limits and the four-project bound.
- The privacy rules: closed vocabulary, ids, hashes and times; no path, prompt, command or free text; nothing leaves the machine.
- Safe behaviour across sessions: no read-modify-write of a shared key, and nothing one session writes can undo another's acknowledgment.
- Recording itself, the conditions that raise an incident, acknowledgment, resolution, the HUD row, and every gate, hold, review and release rule.

## Human acceptance procedure (for when it exists)

1. With `guardRecordOnly` on and `guardAlerts` off, let a project accumulate incidents, or use recorded fixtures.
2. List the unreviewed occurrences and label several of each kind. Confirm each label reads back, can be changed, and can be removed.
3. Ask a model-driven or headless origin to set a label: it is refused, and nothing changed.
4. Confirm that labelling left every acknowledgment as it was, every occurrence's resolved state as it was, and the since-last-look summary as designed.
5. Read the report with only a few labels: it shows counts and `INSUFFICIENT EVIDENCE`, not a rate. Label more and read it again: the figures appear with their counts and interval, the unreviewed count falls, and the parts of the policy that were not simulated are named.
6. Change `guardNotifyKinds` and the quiet-hours window in the config menu and read the report again: the simulated outcomes follow the settings, and `security-failure` is still always a notified kind.
7. Confirm nothing was sent at any point: no notification, sound or bell, and `/cockpit guard` shows no alert sent by the simulation.
8. Confirm `guardAlerts` is still off, and that no gate, hold, review or release state moved.
9. In two sessions of the same project, label different occurrences at the same time, then the same occurrence differently: no label is lost in the first case, and the later one stands in the second.
10. Let an occurrence expire from the bounded history: its label no longer appears and is counted nowhere.

## Acceptance criteria

- Labels are set only by a person, one occurrence at a time, in a closed vocabulary of three.
- Acknowledgment, resolution and notification preference are three separate stored facts, and no operation on one changes another.
- The simulation uses the live policy's own decision, sends nothing, and names what it did not simulate.
- The report gives precision, missed wanted notifications within the observed set, sample size and unreviewed counts, and distinguishes insufficient evidence from poor performance.
- No figure is described as detection recall.
- Nothing is enabled, changed, cleared or approved automatically, and `security-failure` keeps its treatment.
- History limits, privacy rules and multi-session safety are as they were, and earlier histories load unchanged.
