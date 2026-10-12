# v0.6.0: Mission Control operations

v0.6.0 turns from alerts back to Cockpit's core job: an accurate picture of multi-agent work, why work is waiting, what evidence is missing and what still needs verification. It adds three read-only views, a small amount of alert maintenance, a genuine two-process acceptance harness, and the repair of the Anthropic Plugin Directory's capability-inspection blocker. Nothing in it changes how alerts are sent, how tasks are admitted, or how DONE is decided.

## Agent inspector: `/cockpit agents` and `/cockpit agents <task>`

`hooks/inspector.ts`, pure, over the swarm (`Ledger.swarm`) and the Run Ledger's agents. The list puts the tasks that need attention first (stalled, escalated, blocked, queued, reserved, running, then finished), at most twelve with a count of the rest, each with its reason under it; then the capacity in use, from the same limits admission applies (`limitsOf`, `occupancyOf`, newly exported from `hooks/swarm.ts`, where `admissionReason` now reads them too: the numbers live in one place); then the host agents the Ledger saw that Cockpit did not assign. The detail view shows one task.

What is shown only when observed, and how it says so otherwise:

| Field | Source | When unobserved |
| --- | --- | --- |
| Model | the Ledger agent's model (and the model asked for) | `model not observed` |
| Effort | requested (the assignment), launch (set on the Agent call), applied (live requests), engine-reported (`effectiveEffort`, or an engine-sourced level) | `launch: none set on the call`, `applied: not observed`, `engine: no report` |
| Activity | `lastActivityAt` after the start; `endedAt` for finished tasks | `none: not started`, `none observed since it started`, `time not comparable` (clock behind) |
| Outcome | the report and its delivery; the commander's verification | `none yet`; a report is `NOT verified (pending)` until the commander verifies it |
| Ownership | the claims, shortened to their last two segments | `the whole repository` for `*` |

No percentage, duration or progress figure is invented: the view has none.

## Blocker intelligence

`blockerOf` explains why a task is not progressing. For a task waiting for admission the answer is the swarm's own `admissionReason`, parsed back into words; no second scheduler or policy exists. Each reason it can return is pinned by a test, and a seeded property test asserts that every waiting task in sixty random swarms gets a known explanation, so a change in the admission wording fails the tests instead of producing a wrong explanation.

| Recorded state | Explanation | Suggestion (information only) |
| --- | --- | --- |
| `dependency X: s` | waiting for task X (s) | wait and inspect X; if X failed or was cancelled, the commander decides |
| `ownership conflict: Y` | conflict with Y over the overlapping claims | wait for Y, or the commander narrows a claim |
| `resource budget` | capacity exhausted: used of limit, and the tier's pool | wait; only the person changes the limits |
| `commander occupied` / `architect occupied` | the main loop / the configured architects are busy | wait |
| admissible | nothing recorded stops it; not yet admitted | the commander admits it |
| reserved | slot reserved; the host has not reported the agent | the commander releases an orphan reservation |
| stalled | no activity since …; ownership retained | a stall is not proof the agent stopped |
| escalated | the agent stopped with an unresolved question | the commander resolves it with a conclusion and evidence |
| cancellation requested | ownership held until the host confirms | wait for the host |
| failed / cancelled | the reported reason, or none | — |
| completed, not verified | reported, not verified | the commander verifies; a FAIL stays a FAIL |

Suggestions are labelled "information only; nothing was changed" and never claim to have done anything (tested). Nothing here clears a security hold, a failed verification or a release NO-GO.

## Verification readiness: `/cockpit ready`

`hooks/readiness.ts` applies the completion rules already in `hooks/model.ts` and `hooks/discovery.ts` to the recorded task and lists what stands in the way: open milestones and blockers; each required gate (a pass reported by Claude is labelled "reported by Claude, not read from a command"; a pass made stale by a change is STALE; `unset` is "not reported yet"); the Stop guard's hold, or its missing completion when it is required; an Opus review not adjudicated; the goal check's criteria met with evidence and its open unknowns. Agent escalations pending the commander, reported-but-unverified agent results and waiting agents are listed apart, as notes, because the completion rules do not make them conditions. The verdict is the task's own: `PERMITS DONE` exactly when the task's status is DONE (a seeded property test over eighty tasks checks this), so the view cannot disagree with the rules or weaken the six-gate requirement.

## Alert maintenance

- **`/cockpit alerts export`** (person-only) prints schema `cobalt-cockpit/alerts-export` version 1: the project hash, a time, and at most 64 occurrences with id, level, kind, task number, recorded times, condition (`OPEN`, `RESOLVED`, `ENDED`), notification (`SENT`, `RECORDED`, `DEFERRED`, `NOT_SENT`, `HELD_BACK`, `NOT_NOTIFIED_*`), channel (for SENT only), reminders and `acknowledged`. Acknowledgments in the store are applied in memory; nothing is written or sent.
- **`/cockpit alerts legacy`** is a dry run over the earlier formats (the v0.5.7 key `alert-history`, v0.5.8 keys `alert-history:<project>`): per project, how many occurrences and how many already have keys of their own. A key is deletable only when it was understood in full and every occurrence it holds exists in an `alert-occ` key. **`/cockpit alerts legacy delete <code>`** (person-only) recomputes the plan, refuses if its code differs from the one the dry run printed (the store changed, or a typo), and deletes only the deletable keys. An unmigrated project keeps the whole key; a value not understood in full is never deleted. A project is migrated when a session with alerts or record-only on starts in it. The v0.5.7 resurrection limit from v0.5.9 is thereby closed for a person who runs the cleanup after migration; until then it stands as documented.

## Two-process acceptance harness

`scripts/acceptance-harness.sh` runs genuine Claude Code 2.1.296 processes (`claude -p` with immediate `/cockpit` commands, which need no model and no credential) in an isolated directory made by `mktemp`: its own `CLAUDE_CONFIG_DIR`, `XDG_STATE_HOME`, a `git archive` snapshot of the plugin and an empty project. It seeds the disposable store with a v0.5.7 history of two projects, starts two processes at once, and checks that both start real sessions (two ledgers), both list the same occurrences of their project and none of the other, the concurrent migration writes both occurrence keys without loss, the export and a deletion are refused to the `sdk` origin, both dry runs agree and delete nothing. It runs in about nine seconds and removes only its own directory. It is engineering evidence: it cannot acknowledge an alert (that is a person's command, and `claude -p` is not one), and it observes no terminal.

## Anthropic Plugin Directory compliance

**Original result.** The Directory validated v0.5.9 at `a98b5ce` as NEEDS CHANGES: validation failed, ten validation notes, and one policy blocker, "Mod uses $ or on in a way the directory couldn't follow", at `hooks/register.tsx:2614`:

```ts
const historyOf = async ($: EngineInterface, project: string): Promise<AlertRecord[]> => historyFrom(await storedOccurrences($, project), await legacyHistory($, project))
```

The notes (from the operator's screenshot; the complete expanded report was not available to this run) were observations, not blockers: file writing near line 1312 (`$.fs.write` of telemetry), session-event interception near 2836, command interception near 2857, a notification call near 2936 (`$.ui.notify`) the Directory does not recognize, tool and command registration near 3629, three informational "watched words" findings, and the icon's image review.

**Investigation.** The Directory's validator is not available locally. Claude Code's own `claude plugin validate` contains a static analyzer of the same family (its refusal texts were read from the 2.1.296 binary: "`$` is passed to something other than a function named at the top of this file or imported from one of the module's own files", "`$` itself is … bound, passed, spread, returned or read", shadowing and spread rules); it accepts the module both before and after this change. The line the Directory refused passes `$` to helpers of the module inside the argument list of a function imported from another file, in an expression-bodied helper that nothing called any more (`historyOf` became dead in v0.5.9). The same nesting appeared at fifteen other sites. **Root cause: not established.** The most likely reading of the Directory's sentence ("pass `$` … only as one whole argument to a function declared at the top of the same file") is that a call which receives `$` must not itself sit inside another call's arguments, because the argument flows into a function outside the file; the dead helper may have mattered too.

**Changes.** All sixteen sites now pass `$` in a statement of their own and hand the result to the outer call (`const facts = await alertFacts($, …)` then `dueOf(facts)`); two expression-heavy spots became top-level helpers (`guardFacts` for the doctor, `refreshAll` for the pane's button, which keeps the two refreshes concurrent); the dead `historyOf` was removed. Evaluation order is unchanged at every site. No capability is hidden behind dynamic access, a cast, reflection or string construction; no hook, refusal, command route or store access changed. The host analyzer's full report (hooks, gating handlers, capability calls with their helpers, environment and state reads and writes) is byte-identical before and after (`claude plugin validate --json`, compared programmatically). The full suite passed unchanged after the refactor (2105 tests), before any feature work was added.

**Regression protection.** `scripts/check-capability-shape.mjs` reads each hooks module with the TypeScript compiler API and reports any use of `$` or `on` outside the stated shapes: `$.noun.method(...)`, `$` as one whole argument of a function declared at the top of the file (or the host's `read`/`update`) where that call is not inside another non-local call's arguments, `on('literal', hook)` on a line of its own, and no shadowing of `$`, `on` or a function `$` is passed to. It carries a twelve-case self-test (including the exact v0.5.9 blocker shape). `scripts/check-capability-shape.sh` runs the self-test and the check over `hooks/` with a pinned TypeScript and is a CI step. It is labelled everywhere as a local approximation: a pass is not the Directory's verdict.

**Documentation.** README gains "Capabilities at a glance": the hook registrations, command interception, registered commands and tools, refusals, notification methods (`$.ui.notify`, `$.ui.toast`, the audio cue or bell), files written, every plugin-store key, local processes, and that no capability comes from another plugin. SECURITY.md and PRIVACY.md were brought into line (the new keys, the export, the cleanup, the read-only views). The icon was not changed; the informational findings that say there is nothing to change were left as they are.

**Directory status: NOT VERIFIED.** The repair is engineering-complete when the gates below pass and the independent reviews return. Whether the Directory accepts it is decided only by the Directory: after this commit is on `main`, the owner uses the existing submission's "Check for new commits", lets it fetch and validate the new commit, and reads the complete result. This run cannot reach the Directory and does not report a result for it.

## Measurements

On the development machine (Bun runtime, mean of fifty calls): `agentsText` over a 512-task swarm 0.16 ms (28 lines, 1.5 KB), `taskText` 0.04 ms, `readyText` with that swarm 0.07 ms. The views run only when a person types the command; no timer, polling or HUD redraw was added. The capability-shape check takes under a second; the harness about nine seconds.

## Tests

`tests/inspector.test.ts` (35): every admission reason worded, a property test over sixty random swarms, reserved/stalled/escalated/cancelling/failed/unverified/running, suggestions never claiming a change, the header and capacity, attention order, no invented model/effort/activity, four kinds of effort, reported versus verified, activity and a clock behind, shortened claims with no private path, unknown and case-insensitive ids, untracked host agents, the empty swarm, widths 30–120, a bound at 400 tasks, inputs unchanged; readiness for no task and no plan, open milestones and gates, reported versus read gates, failed and stale gates, the Stop guard hold and missing completion, an unadjudicated review and an incomplete goal check, notes for escalations and unverified results, a property test of the verdict against the task's own status over eighty tasks, DONE, no mutation, a narrow width; and through the host, both commands read-only from any origin, `ready` agreeing with the progress tool, the agents view of a Ledger swarm, and a legacy Ledger. `tests/alerts-export.test.ts` (14): the schema, separate notification and acknowledgment fields, closed vocabulary, the bound, the project name, the cleanup plan (migrated, partly migrated, another project, unreadable values, the code), and through the host the export writing nothing and applying acknowledgments in memory, and the dry run, a wrong or stale code, a non-person origin, and a safe deletion that keeps the occurrence keys.

## Human acceptance (NOT VERIFIED until you do it)

1. In a session that uses subagents, run `/cockpit agents` while they work: each task's state, wave, capacity, and for a waiting task its reason; `/cockpit agents <task>` for one of them shows effort as requested and as applied, with "not observed" where the host reported nothing.
2. `/cockpit ready` before and after the gates pass: `DOES NOT PERMIT DONE` with the open items, then `PERMITS DONE` once the progress tool says DONE; a pass the model reported is labelled as such.
3. `/cockpit alerts export` prints JSON; `/cockpit alerts legacy` prints a dry run; nothing changes until you type the delete with its code.
4. Narrow the terminal to about 40 columns and repeat: lines shorten and keep the counts.
5. Optionally run `scripts/acceptance-harness.sh` and read its checks.

## Still NOT VERIFIED

The Directory's acceptance of the repair; v0.5.9's record-only behaviour observed by a person (still awaiting the operator); the new views at a real terminal; live multi-agent sessions (the views are tested on recorded swarms); anything the Directory checks that the local approximation does not.
