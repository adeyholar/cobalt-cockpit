# v0.5.3 submission compliance evidence

Investigation date: 2026-10-12. **External status: NOT VERIFIED.** This is preparation evidence, not a directory GO. Final exact-commit artifact results belong in the release gate record with the archive hash and SHA.

## Three validation layers

| Layer | Establishes | Cannot establish |
| --- | --- | --- |
| Runtime, tests and supported-host TypeScript | Behavior, regressions and API compatibility | Marketplace rules or directory acceptance |
| Local strict validator, public audit and artifact checker | Accessible schema, source/entrypoint identity, known static checks and disclosures | Every portal rule, authenticated metadata, name availability or policy approval |
| Anthropic portal Validate, security scan and reviewer result | Actual external result for the source commit read | Results for a later commit |

Local `claude plugin validate --strict --json .` passed during investigation with no errors or warnings. It identified all 32 literal hooks, including seven in `registerLedger(on)`, and both tool-registration calls. It lists 19 gating hooks: 18 have catches; `plugin.register` is a read-only observer forwarding `next(e)`, and never approves or denies registration. This result predates final corrections and must be rerun on the final artifact.

## Original findings and current source

| Rule / evidence | Before | Current source; external result |
| --- | --- | --- |
| `MOD_PERMISSION_ANSWER_UNREAD`, copied portal report for `main@310da52` in `implementation-v0.3.2.md` | `tool.check` returned a named verdict the scanner could not read | Removed in `15dcfb1`; no permission-check hook or query. Regression tests cover host allow/ask/deny and dangerous-call refusals. Portal after-result unavailable |
| `MOD_IMPORT_DYNAMIC_MISSING`, same report | Type-position `import('../types').Ledger` in `hooks/replay.ts:36` | Static type import since `15dcfb1`; public audit prohibits `import()` in hooks. Portal after-result unavailable |
| `MOD_CAPABILITY_USE_NOT_PLAIN`, user-reported code | Later reported by the owner at `hooks/register.tsx:1222` for `main@ba889d6` (the same expression as line 1045 on v0.5.2): a `.filter(([key, on]) => ...)` callback whose binding shadowed the registration function `on`. Earlier: original per-finding report, source SHA and code-file metadata not supplied or located | Binding renamed to `isEnabled`, logic unchanged; the local strict validator prints identical output before and after, so only a new portal check can show whether the rule is closed. Unresolved external evidence. `39fc24f` renamed `h` bindings reported at old lines 254, 256 and 300 and elsewhere; changelog preserves that attribution. Local `h`/`Fragment` approximation and strict validation cannot demonstrate this portal rule is fixed |

The copied portal report confirms helper registration was recognized. Current hooks use direct `on('literal.event', ...)` with literal matchers. Security catches explicitly deny/refuse or forward `next(e)` as appropriate. There is no permission-check hook, permission approval, dynamic code load, reflective registration or alias for `on`. `PROGRESS_TOOL` and `SWARM_TOOL` are readable static object constants passed to `$.tool.register`, recognized by host and local scanner. Speculative changes to these security paths cannot prove the missing rule closed, so registration behavior is preserved.

Search scope: repository/history, related projects, accessible `/tmp` scratch artifacts, local Claude project sessions and Codex sessions. The exact capability code appeared only in this mission and its execution records. Available historical evidence is the copied portal report and changelog, not an original report export or screenshot.

## Shipped tree and disclosures

The root archive includes hidden manifests/GitHub files, all hooks/helpers, seven agents, tests/fixtures, types, scripts, docs and assets. The artifact checker inventories every extracted file including hidden paths, rejecting extra local files, symlinks, missing files, changed bytes/modes and missing runtime import/entrypoint targets. `hooks/hooks.json` resolves its module from `hooks/`; manifest declarations and icon paths resolve from root. Generated host declarations, ignored `.claude/` and `.freebuff/` are not shipped. Portal `codeFile` metadata remains unavailable.

README, SECURITY.md and PRIVACY.md disclose read-only Git/file fingerprinting, local telemetry maintenance, audio players, the enrolled owner verifier and opt-in router. Authentication values are immediately reduced to presence booleans and credential kind, and the credential handle is discarded. There is no service credential forwarding, MCP server, HTTP client, runtime downloader, package launcher or permission-mode override in runtime hooks. Owner-selected JEV mode lets the separate local router contact TypeSafe with fixed-vocabulary keywords under the router's credential; Cockpit never reads that key.

Development/CI scripts visibly install validation tools, not runtime hooks. `dev-launch.sh` selects a user-requested Auto-mode session via a temporary CLI overlay without editing persisted permissions. Icon/sound scripts generate bundled assets. Scan/typecheck scripts are release tools. `check-submission.py` reads source/artifact identity. Synthetic credential-shaped fixtures and narrow historical Gitleaks exclusions are scan evidence, not forwarding.

The [current checklist](https://claude.com/docs/plugins/pre-submission-checklist) holds non-image/font files at least 256 KiB and uninspectable binaries for a reviewer. The large register module and two WAV cues remain disclosed holds; no feature removal or scanner suppression was made to clear them.

## Policy and external blocker

The [Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy) requires necessary collection, accurate capabilities, readable instructions, privacy/contact information and user-intended external software use. Section 1.F prohibits querying/extracting user files, memory, chat history and summaries. Cockpit reads files for fingerprints and successful Edit/Write replay, retaining bounded local task/ledger data. These are disclosed functional behaviors; local tests cannot decide Anthropic's interpretation for this mod. Present them explicitly for policy review alongside opt-in JEV routing. Do not claim full policy approval from this report.

The [official checklist](https://claude.com/docs/plugins/pre-submission-checklist) and [submit guide](https://claude.com/docs/plugins/submit) require re-validation after a pushed fix and say the portal checks more than the local command. A public portal read returned logged-out public content. A read-only OpenCLI tab probe failed with **Browser Bridge extension not connected**. No directory API/tool or authenticated validator session is available here. No submission was attempted.

Next action: an authenticated owner must Re-validate the exact candidate and preserve the full report, especially the capability rule and source/code-file metadata. Until this central evidence is received, the submission gate and a fully accepted v0.5.3 release remain NO-GO. Detailed artifact commands and owner steps are in [marketplace-submission.md](marketplace-submission.md).

## Capability correction found during final recovery

The accessible strict host validator rejected passing the engine capability `$` into an imported Git measurement function. Measurement and process calls now remain local to `register.tsx`; `git-integrity.ts` exports only pure constants, types and tree parsing. This removes that observed local capability violation without hiding calls or weakening hooks. It is not evidence that the missing external `MOD_CAPABILITY_USE_NOT_PLAIN` report has been resolved. The final gate record must preserve the newly rerun local result and the external NOT VERIFIED status separately.
