# v0.5.3: authorization and identity hardening

Each item below was reproduced against 0.5.2, has a regression test that failed before the correction, and is limited to the reproduced behavior.

## M1. The SDK origin is not human authority

`PromptOrigin.kind: 'sdk'` means "the SDK host's own turn (`claude -p`, the Agent SDK)". The host does not say who started it, and an agent that runs `claude -p` from a tool call produces the same stamp. A trusted-host signal that separates a person's SDK session from an agent-controlled one does not exist in Claude Code 2.1.296, so the privileged commands fail closed.

`isHumanAuthority` (hooks/origin.ts) accepts `composer` and `bridge` only. It guards every command that changes protected state: `reset`, `guard trust`, `guard untrust`, `guard release`, `guard ack`, `guard silence`, `discovery light|standard|deep|auto`, `router <mode>`. Reading (`status`, `guard`, `discovery`, `router`, `doctor`, `stats`) is open to every origin. `isPersonOrigin` (composer, bridge, sdk) still decides whether a prompt may start or classify a task, which grants nothing.

Compatibility: a headless SDK or `claude -p` session can no longer enroll, release, reset or pin. Run those commands from the terminal or the Remote Control bridge. Nothing in a saved state changes. Scope: the bridge is treated as the person's own channel, as in 0.5.2. Settings that are not guard settings (for example `cobaltStrict`) are not covered by this item.

Tests: `tests/origin-boundary.test.ts`; `tests/release-budget.test.ts` (reset origins).

## M2. Project identity in the fingerprint

The tree fingerprint (`head:count.hash`) gains `@<project>`: the first 128 bits (32 hex) of a SHA-256 over a domain tag and the git work tree path (`rev-parse --show-toplevel`, resolved by git). No path is stored. `compareTree` returns UNKNOWN unless both fingerprints name a valid project identity and it is the same one; a fingerprint saved by 0.5.2 (no identity), one from the earlier 32-bit form of this release (`@` and 8 hex), a malformed one and one longer than `STAMP_MAX` (160) are all UNKNOWN, equal or not. UNKNOWN is never read as unchanged and asks for the check. A task saved by 0.5.2 and finished by 0.5.3 is therefore checked once. Moving to another checkout and back is the same project again.

Storage: `STAMP_MAX` is the single bound for a stored fingerprint (`CheckRecord.tree`). The longest stamp this build writes (SHA-256 repository, nine-digit entry count) is 124 characters; the earlier bound of 96 would have silently dropped a record. Boundary tests cover the longest stamp, an oversized one and the file-count limits (20,000 tracked, 100,000 ignored).

What the identity guarantees: two different work tree paths do not collide in practice (128 bits). It does not make the check a sandbox: a process with write access to the repository, the plugin store or the settings can change what is measured. The fingerprint stays a change detector.

Tests: `tests/project-identity.test.ts`.

## M3. Consultation identity

`roleOf` returns ARCHITECT only for the exact type `cobalt-cockpit:architect`. Before, any name that ended in `:architect` (or was `architect`) took an admitted consultation's `[task:ID]` and ran on Opus. The other roles are unchanged. The separate human publication decision is unchanged.

The host's `agent.spawn` event also carries `provider`, set by the host from where the definition came from, not by a plugin. The architect is refused unless `provider.plugin` is `cobalt-cockpit`. Admission (`swarm consult`) opens the task, `agent.spawn` binds the agent id to it, the outcome is read from the completion the host observed for that agent id, it cannot be more favourable than the architect's single `DECISION` line, and publication stays a separate human decision.

Not proven: a second plugin that is itself named `cobalt-cockpit`, installed from another source, would carry the same provider name. The host exposes no stronger provenance to a hook. The independent human publication gate is the control for that case.

Tests: `tests/consult-identity.test.ts`.

## L1. Guard settings

`config.set` refuses a row of this plugin's Stop guard or alert settings unless it came from the composer (the person in the config menu). A plugin's `$.config.set` and the bridge are refused. Other rows, and other plugins' rows, are untouched. Options are fixed for an activation, so the effect of a change lands at the next reload.

Tests: `tests/guard-settings.test.ts`.

## L2. Check records and the refusal budget

The refusal budget of a held task is authoritative on the task: `spentOf` is the larger of the run of unfinished checks in the log and the hold's own `refusals` counter, which is written in the same step as the hold and survives a restart with the task. A log that was evicted, flooded by other tasks, lost, corrupted or never written cannot give a held task its attempts back. A person's release removes the hold and with it the counter, as before. The log is still bounded per task (16) and in total (128, the newest four tasks protected), but nothing depends on it for the budget.

Not claimed: cross-process consistency. The plugin store has no atomic compare-and-set, so two sessions writing the durable check log at the same moment can lose a record; the counter lives in the task state, which is why the budget does not depend on that log. A durable store that cannot be written is covered by the same property (the write is best-effort); the host test world has no hook to fail `store.set`, so this is argued from the code and from the lost-log tests, not exercised by a failing write.

Tests: `tests/check-retention.test.ts`, `tests/refusal-budget.test.ts` (1,000 unrelated checks, a missing, corrupted, wrong-version or garbage log, an existing 0.5.2 hold).

## L3. Index flags and git configuration in the release clean-tree check

`candidateOf` runs git with the same hardened invocation as the tree fingerprint (`GIT_SAFE`: no replace objects, no fsmonitor, no untracked cache, no submodule shortcuts), so a repository-controlled fsmonitor hook or a replace ref cannot make `status` look clean. After `git status` is clean, `git ls-files -v -z` is read; a lowercase tag (assume-unchanged) or `S`/`s` (skip-worktree) makes the candidate unknown, and a failing listing does too.

Tests: `tests/release-budget.test.ts`.

## L4. Verification timeout

The ceiling is 600 seconds (`TIMEOUT_CEILING_MS`), the maximum of the host's `process.run` (ten minutes). A larger `verifyTimeoutSec` is lowered to it.

Tests: `tests/stopguard.test.ts`.

## Residual limitations (documented, not fixed)

- Settings files: Cockpit enforces guard settings only on the host's configuration event (`config.set`). A process or plugin that edits the settings files directly takes effect at the next reload and is outside what Cockpit can see.
- Cockpit is not a sandbox against a process with broad filesystem access: it can edit the plugin store, the settings and the repository.
- Host-origin and plugin-provenance guarantees are exactly what the host stamps: `composer` and `bridge` are taken as the person; `sdk` cannot be told from a nested `claude -p`; a plugin's own name is the only provenance for an agent definition.
- Only the guard and alert settings are protected from another plugin's `$.config.set`; other options are not.

## Marketplace

`hooks/register.tsx` is above 256 KiB. That threshold is a reported figure, not a confirmed directory requirement, and no split is part of this release. See `docs/marketplace-submission.md`.
