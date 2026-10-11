# Draft issue for anthropics/claude-code (not filed)

**Title:** Officially supported unattended command to generate plugin host TypeScript declarations

**Problem.** A hooks-module plugin type-checks against declarations the host writes to `.claude-plugin/types/` ("written by the engine each time it loads a mod from a folder the person owns"). There is no documented command that produces them without an interactive session, so a CI job cannot reproduce a complete TypeScript check of a plugin from a clean checkout.

**What we observed** (disposable clean clones, Linux, `CI=true`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, fresh config directory, launch `claude --plugin-dir "$PWD" -p '/cockpit version'`, a host-only slash command that needs no model call):

| Claude Code | Declarations written by that headless launch? | Notes |
|---|---|---|
| 2.1.294 | Yes | But they lack `$.ui.notify`, which our plugin needs; the official plugin tests fail on this version for the same reason. |
| 2.1.295 | No | Launch succeeds, directory not created. |
| 2.1.296 | No | Same. Also tried: relative `--plugin-dir`, the person's usual config directory, an already trusted working directory. |
| 2.1.296, interactive session in a trusted folder | Yes | Working declarations, first line `// Written by Claude Code 2.1.296.` |

`claude plugin validate --strict` and `claude plugin test` pass on 2.1.296 but do not write the declarations.

**Request.** One of: a subcommand (for example `claude plugin types <dir>`) that writes the declarations deterministically and exits non-zero on failure; or a documented flag or environment variable that makes the headless `--plugin-dir` launch write them; or published, versioned declarations (with a license that permits redistribution) that a plugin can install as a dev dependency.

**Why it matters.** Without it, a plugin's CI can pin the host and run tests and validation but cannot type-check, so TypeScript becomes a manual release step. Declarations are marked early access, so redistributing a copy ourselves is not something we are willing to do without permission.

No project files, credentials or paths are included.
