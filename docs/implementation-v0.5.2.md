# v0.5.2 implementation notes

Baseline v0.5.1 (eeab1ba). Nothing here publishes, tags, pushes or installs.

## Confirmed host storage capabilities

The hooks runtime has no Node and no `require`. `$.fs` offers read, whole-file write, list, exists and stat only: no append, no mode, no rename. `$.store` is one JSON file capped at 4 MiB. `$.process.run` takes an argv; a refusal is final and is never retried by another route.

## Persistence design (telemetry)

Each process writes only its own sealed segment (`hooks/telemetry.ts`, `telemetry-store.ts`): 64 KiB per segment, 4 MiB total, 13 months, whitelisted fields only. A torn write is bounded to one segment. Retention deletion uses `rm -f` on exact telemetry file names and is best effort. Directory/file modes are requested with `mkdir -m`, read back with `stat`, and reported as verified or unverified. Storage is not append-only and no stronger claim is made.

## Subagent prompt-cache policy

Precedence (Claude Code 2.1.296, non-main requests): FORCE_5M, environment, setting, agent `cacheTtl`, ENABLE_1H, default 5 minutes; the controls need Claude Code 2.1.242 or later. The setting value is the string `"1h"`. Environment changes need a new process; whether a running session reloads settings is unverified. `/cockpit doctor` reports configuration intent and an opt-in recommendation; it edits no settings, sets nothing, makes no model call and makes no savings claim. The 5-minute/1-hour cache-write split is not exposed by typed usage, so the effective behaviour is UNKNOWN.

## Stop-hook verification guard (`hooks/stopguard.ts`)

`classic.Stop` with `{ block: reason }`. OBSERVE does nothing. ENFORCE runs the owner's `verifyScript` (absolute path, argv only, cwd the project) for a task that changed files, or, for a non-read-only task, a repository that shows uncommitted changes (so edits by MCP tools or Bash commands with no edit diff are not missed).

**Trust model (remediation of the v0.5.2 review).** A configured path is never trusted by itself. A person enrolls a script with `/cockpit guard trust`, which prints the path, the sha-256 of its raw bytes and the project, and enrolls nothing; only `/cockpit guard trust <first 12 hex>`, typed by a person (composer, bridge or SDK origin), stores the record. Plugins, triggers, peers, models and unknown origins are refused. The record lives in the plugin store, per project and path, survives restarts and task resets, and ends when the bytes change; `/cockpit guard untrust` removes it. `verifyScriptSha256` is checked on top of enrollment and never replaces it, which also means a repository that sets plugin options cannot get its own script run without a person enrolling it. A task keeps the verifier it started with. Not covered: anything the script itself runs (interpreters, test files, other scripts) and the interval between the hash and the exec (no exec-by-descriptor exists in the plugin API).

**Refusal budget.** Every check since the last one that completed the task is an attempt (`attemptsOf`); a pass that still left completion refused (no change summary) is an attempt and cannot reset the budget. Default 3, ceiling 10. When it is spent the stop is allowed and the task carries a protected hold (`task.stopHold`); DONE is never produced. The record is kept in the Run Ledger (`stopChecks`), so a resumed session finds the budget as it was. A closing message is required to carry a summary only when the host supplies one at all.

**Freshness.** The working-tree fingerprint is taken before and after the run; a tree seen to move is `unstable` and counts as an attempt, not as verification. Two fingerprints are not an atomic snapshot (an edit that is undone, or one outside git's view, is invisible), and a directory that is not a git repository has no fingerprint: the exit code is then accepted without stamping the gates, and the evidence says "tree state unknown". A pass sets only the TEST gate and never clears an Opus review or release approval. While the guard holds a task, the progress tool cannot `unblock`, `block`, or change the TEST gate (`isGuardHeld` in `model.ts`); only a person's `/cockpit reset` releases it. Other paths that set gates are the existing observed Bash readings, which do not remove the blocker.

Other outcomes: missing, untrusted or unstartable scripts are final for the task (BLOCKED, stop allowed, no retry); a timeout counts as a failure. A task is identified by `number@start-time`, so a reset never inherits an earlier task's attempts or alert history.

### The hold is protected task state (`task.stopHold`)

The hold is a field of its own, with its reason and refusal count; it is not the blocker text. No progress action (`plan`, `replan`, `start`, `unblock`, `block`, `fail`, `complete`, `gate`/`gates`, `discover`, `decide`, `align`), no Bash-ingested test result and no model-written `STOP GUARD:` blocker can create, move or lift it. A re-plan carries it (and the task's identity) forward; a read-only declaration cannot shed the TEST gate while it stands; the TEST gate cannot be set through the progress tool while it stands; and the model refuses 100% / DONE (`isVerified`, `statusOf`, the VERIFY milestone) on the field itself, whatever the host layer does. Only two things lift it: a fresh check by the enrolled script that passes and completes the task, or a person's `/cockpit guard release` (composer, bridge or SDK origin only), which clears the hold and starts the budget over but sets no gate: TEST stays pending, and SECURITY and release approvals are untouched. `/cockpit reset` is the explicit new task and carries nothing. The script is re-hashed before every execution and once after it; a swap between two runs or during one is `untrusted`, never a pass. An exception inside the guard holds the task (`the Stop guard raised an error while checking`); it is never a silent pass. A task declared read-only is measured against the tree, so a claim of read-only work cannot skip verification when changes are detected or the tree state is unknown.

### Migration of tasks saved by the previous schema

A task saved before the hold was a field (no `guardSchema`) is settled once, deterministically and idempotently (`migrateStopHold`), before any action can touch it. The evidence is only the guard's own check records in the Run Ledger, which the model cannot write; the blocker text proves nothing. An unfinished check record plus the guard's blocker, a spent budget, or a check that could not run: held, with the budget as the records show it (never reset). A guard-looking blocker whose records all completed, or whose records were unreadable: held as ambiguous, to be cleared by a fresh check or a person's release; nothing is granted. A guard-looking blocker with no record at all is an ordinary blocker and stays one. OBSERVE tasks, completed tasks, ordinary blockers and failed gates are unchanged. Script trust is not read from legacy hashes or configuration: enrollment lives in its own store, so a missing or changed script stays untrusted and the task stays held. Records of another verifier do not let a different script take the task over.

### The task baseline and the read-only claim

A model's "read-only" is a claim, not proof. When the Stop guard is enforcing, the host takes a working-tree fingerprint (`startTree`: HEAD plus the content hash of every tracked change and every untracked, non-ignored file) when a task begins, at the prompt that creates it and before any work of that prompt. An unfinished task keeps its baseline through later prompts, plans and re-plans; nothing a model sends can set or move it (it is not an input of the progress tool, and a later fingerprint never replaces it). A read-only plan is accepted only when (a) the baseline is a known fingerprint, (b) the fingerprint now is the same, and (c) no Edit, Write or Bash edit diff was seen for the task. Otherwise the task is planned as coding, the reply says so, and the check applies. At the Stop, a read-only task is measured against the baseline again, so a change after the declaration is caught too.

Consequences, stated plainly. No baseline (the first thing that happened was a progress call, or a task saved by an earlier build), no git repository, a tree too large to fingerprint, or git not answering: the state is unknown, and unknown is treated as changed, so a read-only claim does not skip verification. The cost is that read-only work in such a place is checked like coding work. Coverage limits: git-ignored files, files outside the repository and anything git does not list are not in the fingerprint; changes there are not detected. Nothing in this paragraph applies when the guard is not enforcing; the read-only claim is then accepted as before.

### Prompts, resets and sessions

A prompt is not a reset. A task the Stop guard holds goes on through a person's next prompt, planned or not, with its hold and budget; only `/cockpit reset` (person-origin) abandons it. The reset marks nothing as passed or done, and the abandoned hold stays in the check record as a `released` entry named `reset` with its reason. The check records are kept in the Run Ledger and also in a durable, versioned store key (`stop-checks`, version 1; a record of an unknown version is ignored, and each record is validated by shape), because a task can be carried into a session whose Ledger starts empty. The attempts spent, the verifier a task began with and the history of a hold are read from both, so a new session neither resets a budget nor lets another script take a task over. If a record is lost from both, nothing is reconstructed or assumed: a guard-looking blocker with no record stays an ordinary blocker, the stop is checked again, and nothing is claimed as verified.

A migrated hold is reconciled with the rest of the task at once: a task saved as DONE / 100% with an unresolved guard hold reads BLOCKED below 100% after migration, and the next prompt keeps the hold. A legitimately completed legacy task is left as it was.

### What the plugin controls, and what it does not

The controls here are plugin-level: the hold, the baseline, the enrolled hashes and the check records are fields and store keys the plugin API gives the model no way to write, and the progress tool has no input that reaches them. They are not a sandbox. A model that is allowed a shell, or a tool that reaches the host's files, may be able to write the plugin store file or the project files directly; nothing here stops that, and this document does not claim the store cannot be modified through every capability a host offers. What the design does give is that the ordinary routes (the progress tool, plans, prompts, test output, forged blocker text) cannot lift a hold or skip a check, and that enrollment, release and reset need a person's own command.

### Mutation audit of the guard's tests

Each protection was removed on its own in a disposable worktree and the suite run (about 45 mutations over three rounds). Every one that violates an invariant fails a named test: the hold in `isVerified`, `statusOf` and the VERIFY milestone; the TEST-gate refusal; the read-only proof (fingerprint, edit and unknown-baseline legs separately); the downgrade to coding; the Stop-time measurement against the baseline (unknown baseline, unknown fingerprint); the baseline carried across prompts; the prompt/hold rule; the migration and its reconciliation of a saved DONE; the durable records and their version check; the verifier lock and the `released` exception; the final-branch hold restoration; the reset record and its person-only origin; the re-hash before and after each run; and the exception-to-hold catch. Surviving mutants are equivalent or defense in depth, not gaps: the `planTask` branch that keeps TEST required on a held task is behind the forced coding kind (one layer cannot be removed without the other being redundant), and a mutant that gave the first progress call a "known" baseline was also stopped by the string check beside it. None of them lets a task read DONE without the check.

### Trust boundaries and the time-of-check/time-of-use limit

- `verifyScript` is read from the plugin's own options; no model output, prompt or tool result can set it. Whether a project-scoped settings file can set plugin options is a host property not verified here; enrollment makes it safe either way.
- The check runs with the plugin API's `$.process.run`, a native hook-runtime call. It is **not** passed through the Auto-mode classifier as a Bash tool call, and this document does not claim it is. Observed live: the runs executed without a classifier prompt. The environment is the plugin host's own (the API can add variables, not remove them).
- Every failure to complete a check leaves the task not DONE.
- The person can always interrupt or end the session; nothing here blocks cancellation.

## Live acceptance (Claude Code 2.1.296, `--permission-mode auto`, disposable fixtures under /tmp/accept)

A OBSERVE: failing test appears in the Ledger as a failed Bash call; no block, no alert, nothing verified. B ENFORCE: first check exit 1 (stop refused), repair, second check exit 0; TEST pass, the other gates unset. C always-failing script: two attempts then BLOCKED, TEST fail, never DONE. D pin mismatch: script never executed (no marker file), BLOCKED, no loop; missing script: BLOCKED, no loop. E alert: one `security-failure` alert across repeated status calls; headless `-p` has no terminal surface, so the host reported `no-surface` and the Ledger records `failed (no-surface)`; SECURITY stays fail. A real SENT could not be produced headlessly and an interactive run needed a trust-folder write to the user's config, which was declined; SENT is covered by host-level tests against a mocked channel only. F review holds, NO-GO, restart: deterministic host-level tests (`tests/alerts-holds.test.ts`); no live Opus call was made for them.

### Live re-check of the two review findings (Claude Code 2.1.296, `--permission-mode auto`, snapshot of the remediated commit, /tmp/accept2)

- Loop: ENFORCE with a script that exits 0, budget 2, a model told to end with the single word "Done." Result: two checks recorded, neither complete, then the stop was allowed with the task BLOCKED; never DONE. (A first run showed a check that leaves an untracked cache directory moving the tree; it is now run once more from that tree.)
- Trust across sessions: a person enrolled the script with `/cockpit guard trust <12 hex>` (accepted live; hash equals `sha256sum`). The agent then rewrote the script. Session 1 and a separate session 2 each recorded `untrusted: changed since it was enrolled`, never a pass, and the task ended BLOCKED. (The marker file the edited script touches exists because the model itself ran it, not the guard; the Ledger holds no pass record.)
- The interactive terminal notification test is still pending the owner's terminal; SENT has not been observed live.

## Cobalt Guard (`hooks/alerts.ts`)

Policy over observed state, evaluated after each progress/swarm tool call and at Stop. Delivery is `$.ui.notify`, the person's own terminal channel. Its result says the host wrote it, not that anyone saw it, so states are SENT/FAILED, never "delivered". Recoverable failures and verified success send nothing. Dedupe key is task-identity:kind:detail (the identity survives resets), also checked against the Ledger so a resumed session does not repeat; only a notification the host wrote ends the matter, a failed or refused one is retried up to three times after the cooldown, and an alert held back by the cooldown or the budget is recorded once with that reason; cooldown (default 300 s) and a per-session budget (default 5) bound the rate; a re-entrancy flag prevents loops. Messages come from a closed vocabulary plus a task number. Alerts are recorded in `Ledger.alerts` (optional field, bounded to 32; older ledgers read unchanged). `/cockpit guard ack|silence` (person origin only) change the display and future sends, never a verdict. Remote paging (webhook, email, push) is deferred to v0.5.3.

## Limitations

- No true append and no mode API; permissions are known only by stat read-back.
- The plugin load order means duplicate-Cockpit detection is partial.
- Whether Auto mode restricts the plugin's own file/process calls must be confirmed in the live acceptance run.
- A notification cannot be confirmed as seen.
- The Stop guard cannot judge a script's quality; the owner owns the check.
