# v0.5.2 implementation notes

Baseline v0.5.1 (eeab1ba). Nothing here publishes, tags, pushes or installs.

## Confirmed host storage capabilities

The hooks runtime has no Node and no `require`. `$.fs` offers read, whole-file write, list, exists and stat only: no append, no mode, no rename. `$.store` is one JSON file capped at 4 MiB. `$.process.run` takes an argv; a refusal is final and is never retried by another route.

## Persistence design (telemetry)

Each process writes only its own sealed segment (`hooks/telemetry.ts`, `telemetry-store.ts`): 64 KiB per segment, 4 MiB total, 13 months, whitelisted fields only. A torn write is bounded to one segment. Retention deletion uses `rm -f` on exact telemetry file names and is best effort. Directory/file modes are requested with `mkdir -m`, read back with `stat`, and reported as verified or unverified. Storage is not append-only and no stronger claim is made.

## Subagent prompt-cache policy

Precedence (Claude Code 2.1.296, non-main requests): FORCE_5M, environment, setting, agent `cacheTtl`, ENABLE_1H, default 5 minutes; the controls need Claude Code 2.1.242 or later. The setting value is the string `"1h"`. Environment changes need a new process; whether a running session reloads settings is unverified. `/cockpit doctor` reports configuration intent and an opt-in recommendation; it edits no settings, sets nothing, makes no model call and makes no savings claim. The 5-minute/1-hour cache-write split is not exposed by typed usage, so the effective behaviour is UNKNOWN.

## Stop-hook verification guard (`hooks/stopguard.ts`)

`classic.Stop` with `{ block: reason }`. OBSERVE does nothing. ENFORCE runs the owner's `verifyScript` (absolute path, argv only, cwd the project) for a task that changed files. Trust: sha-256 taken at session start (or the pinned value); a changed script is untrusted and not run. Outcomes: pass sets the TEST gate (with the tree fingerprint) and nothing else; fail/timeout block with a bounded redacted reason until `stopMaxContinuations` is spent; missing, untrusted or unstartable scripts are final (BLOCKED, stop allowed, no retry). Budget exhaustion sets a task blocker `STOP GUARD: …` and allows the stop. A pass never clears an Opus review or release approval.

## Cobalt Guard (`hooks/alerts.ts`)

Policy over observed state, evaluated after each progress/swarm tool call and at Stop. Delivery is `$.ui.notify`, the person's own terminal channel. Its result says the host wrote it, not that anyone saw it, so states are SENT/FAILED, never "delivered". Recoverable failures and verified success send nothing. Dedupe key is task:kind:detail, also checked against the Ledger so a resumed session does not repeat; cooldown (default 300 s) and a per-session budget (default 5) bound the rate; a re-entrancy flag prevents loops. Messages come from a closed vocabulary plus a task number. Alerts are recorded in `Ledger.alerts` (optional field, bounded to 32; older ledgers read unchanged). `/cockpit guard ack|silence` (person origin only) change the display and future sends, never a verdict. Remote paging (webhook, email, push) is deferred to v0.5.3.

## Limitations

- No true append and no mode API; permissions are known only by stat read-back.
- The plugin load order means duplicate-Cockpit detection is partial.
- Whether Auto mode restricts the plugin's own file/process calls must be confirmed in the live acceptance run.
- A notification cannot be confirmed as seen.
- The Stop guard cannot judge a script's quality; the owner owns the check.
