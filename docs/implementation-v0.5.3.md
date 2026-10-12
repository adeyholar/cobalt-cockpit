# v0.5.3: authorization and identity hardening

Each item below was reproduced against 0.5.2, has a regression test that failed before the correction, and is limited to the reproduced behavior.

## M1. The SDK origin is not human authority

`PromptOrigin.kind: 'sdk'` means "the SDK host's own turn (`claude -p`, the Agent SDK)". The host does not say who started it, and an agent that runs `claude -p` from a tool call produces the same stamp. A trusted-host signal that separates a person's SDK session from an agent-controlled one does not exist in Claude Code 2.1.296, so the privileged commands fail closed.

`isHumanAuthority` (hooks/origin.ts) accepts `composer` and `bridge` only. It guards every command that changes protected state: `reset`, `guard trust`, `guard untrust`, `guard release`, `guard ack`, `guard silence`, `discovery light|standard|deep|auto`, `router <mode>`. Reading (`status`, `guard`, `discovery`, `router`, `doctor`, `stats`) is open to every origin. `isPersonOrigin` (composer, bridge, sdk) still decides whether a prompt may start or classify a task, which grants nothing.

Compatibility: a headless SDK or `claude -p` session can no longer enroll, release, reset or pin. Run those commands from the terminal or the Remote Control bridge. Nothing in a saved state changes. Scope: the bridge is treated as the person's own channel, as in 0.5.2. Settings that are not guard settings (for example `cobaltStrict`) are not covered by this item.

Tests: `tests/origin-boundary.test.ts`; `tests/release-budget.test.ts` (reset origins).

## M2. Project identity in the fingerprint

The tree fingerprint (`head:count.hash`) gains `@<project>`, a hash of the git work tree path. `compareTree` returns UNKNOWN when the two fingerprints were taken in different projects, or when only one has a project (a fingerprint saved by 0.5.2). UNKNOWN is never read as unchanged and asks for the check. A task that is saved by 0.5.2 and finished by 0.5.3 is therefore checked once. Moving to another checkout and back is the same project again.

Not covered: a symlink that resolves to the same work tree is the same project by design (git reports the resolved path); a copy of the repository at another path is another project.

Tests: `tests/project-identity.test.ts`.

## M3. Consultation identity

`roleOf` returns ARCHITECT only for the exact type `cobalt-cockpit:architect`. Before, any name that ended in `:architect` (or was `architect`) took an admitted consultation's `[task:ID]` and ran on Opus. The other roles are unchanged. The separate human publication decision is unchanged.

Tests: `tests/consult-identity.test.ts`.

## L1. Guard settings

`config.set` refuses a row of this plugin's Stop guard or alert settings unless it came from the composer (the person in the config menu). A plugin's `$.config.set` and the bridge are refused. Other rows, and other plugins' rows, are untouched. Options are fixed for an activation, so the effect of a change lands at the next reload.

Tests: `tests/guard-settings.test.ts`.

## L2. Check-record retention

Check records are retained per task (16) and then in total (128); the oldest records of the older tasks go first and the newest four tasks are never evicted by others. A held task's run of attempts (at most 10) always fits.

Tests: `tests/check-retention.test.ts`.

## L3. Index flags in the release clean-tree check

After `git status` is clean, `git ls-files -v -z` is read; a lowercase tag (assume-unchanged) or `S`/`s` (skip-worktree) makes the candidate unknown, and a failing listing does too.

Tests: `tests/release-budget.test.ts`.

## L4. Verification timeout

The ceiling is 600 seconds (`TIMEOUT_CEILING_MS`), the maximum of the host's `process.run` (ten minutes). A larger `verifyTimeoutSec` is lowered to it.

Tests: `tests/stopguard.test.ts`.

## Marketplace

`hooks/register.tsx` is above 256 KiB. That threshold is a reported figure, not a confirmed directory requirement, and no split is part of this release. See `docs/marketplace-submission.md`.
