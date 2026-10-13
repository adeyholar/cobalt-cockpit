# v0.6.1: Smarter swarm operations

> Part of the [Cobalt Cockpit documentation](README.md). Summary: [CHANGELOG](../CHANGELOG.md).

Four changes to multi-agent work, none of which adds a setting, a background process or a way to start an agent: bounded work reaches Haiku more usefully, a scoped reviewer can inspect Git, a home directory's user name is hidden under more layouts, and the HUD says when the swarm needs someone. Observation stays the default, and every pool ceiling, dependency, ownership rule, native permission prompt, security hold and release NO-GO is as it was in v0.6.0.

## Why Haiku was under-used

`routeTask` in `hooks/swarm.ts` already said a bounded, extractive task suits Haiku. Four things kept that from turning into useful Haiku assignments.

1. **The policy had no caller.** `routeTask` was exported and tested and nothing at runtime called it. No assignment ever carried a suggestion.
2. **A read-only helper could not search.** Claude Code 2.1.296 declares no `Grep` or `Glob` tool (`.claude-plugin/types/claude-code-tools/index.d.ts` lists neither), so a helper's only search is Git through the shell. The v0.6.0 guard refused every shell command of a task that did not own `*`. For a task that did own `*` it refused any command containing the `--` separator: the bare `--` is a prefix of each long option on its refusal list, so it matched. It also refused `git -C`, `cd … &&`, a pipe, and a pattern containing `$`, `<` or `>` even inside single quotes.
3. **A wide claim is expensive for the commander.** A `*` read claim holds the commander's own edits until the helper ends, and any running helper holds the commander's shell. A scout that needed `*` to search therefore stopped the commander's work for as long as it ran.
4. **The instructions did not match the guard.** The commander was told to "prefer Haiku" for reconnaissance without what a scout can do or what a claim costs. The reviewer definition said to run tests, type-checks and lint, and the explorer's to use `ls` and `wc`; under an assignment the guard refuses all of them.

Observed in the session that built this release, under the installed v0.6.0 guard: four Haiku scouts were assigned at the start of reconnaissance, each with a `*` read claim. One, whose brief named the files to read, returned a complete inventory. The other three returned PARTIAL and each gave the same cause unprompted: no Grep or Glob tool, and a refused shell.

| Scout | Work | Outcome | Tool uses | Tokens | Time |
|---|---|---|---|---|---|
| verification inventory | read named docs, scripts and workflows | complete | 32 | 117,626 | 67 s |
| routing surface | reference search across `hooks/` | partial: could not search | 17 | 56,421 | 50 s |
| HUD surface | file discovery and reference search | partial: could not search | 7 | 21,886 | 22 s |
| path surface | classify call sites across `hooks/` | partial: read whole files instead of searching | 20 | 165,697 | 87 s |

Requested 4, admitted 4, spawned 4, completed 4, verified by the commander 1; the other three were recorded as `unknown`. Those are one session's figures, not a benchmark.

## What changed for delegation

**A helper can search inside its scope.** See [Scoped read-only Git inspection](#scoped-read-only-git-inspection). The fourteen commands below are what an inventory, a reference search or a diff review needs. Each was judged by the v0.6.0 rule (taken from the v0.6.0 source text) and by the v0.6.1 rules:

| Written | v0.6.0, `*` scope | v0.6.0, named paths | v0.6.1, `*` scope | v0.6.1, named paths |
|---|---|---|---|---|
| with `--` before the paths | 1 of 14 | 0 of 14 | 14 of 14 | 14 of 14, each path checked |
| without `--` | 12 of 14 | 0 of 14 | 14 of 14 | 1 of 14 (the paths must be explicit) |

The fourteen: list a directory's tracked files; list its untracked files; find a function's callers; search for `$.process.run`; search for `on => `; a case-insensitive alternation; a branch's diff for one file; its `--stat` for a directory; a file's history; the patches that touched it; one commit limited to a directory; a file at a revision; what is uncommitted in a directory; when a string was introduced. The two a `*` scope refused in v0.6.0 without `--` are the patterns containing `$` and `>`.

**Each assignment records a route suggestion.** `suggestRoute` reads four fields the commander sets on purpose and nothing else. The objective's words are not evidence.

| In order | Condition | Suggests | Reason recorded |
|---|---|---|---|
| 1 | the commander assigned OPUS | OPUS | commander work, as assigned |
| 2 | the role names an architect | OPUS | architecture belongs with the commander |
| 3 | mode `write` | SONNET | a write task is engineering work |
| 4 | the role is a reviewer's | SONNET | independent review needs engineering judgement |
| 5 | effort named `high`, `xhigh` or `max` | SONNET | the commander named heavy reasoning |
| 6 | the role is a scout, inventory, utility or triage | HAIKU | bounded extractive read (the role) |
| 7 | effort named `low` | HAIKU | read-only work the commander named light |
| 8 | the wave is RECONNAISSANCE and the role is not an explorer's or a researcher's | HAIKU | read-only reconnaissance |
| 9 | anything else | SONNET | read-only investigation |

Rules 3 to 5 come before 6 to 8, so a write, a review or work named heavy is never suggested to Haiku. The result is `routeTask` itself, given `architecture`, `extractive` and `bounded` from these fields: the policy that was dormant is the one that now runs.

The suggestion is stored on the task (`suggestedTier`, `routeReason`) beside the commander's `tier`, which is what admission and the spawn use. When they differ, the reply to `assign` says so, and the Ledger's assignment event carries it:

```text
Task lookup queued; use Agent description [task:lookup]. OPUS tasks stay in main. ROUTE / HAIKU suggested (bounded extractive read (the role)); SONNET kept as assigned. The choice is yours: cancel and assign again to change the tier.
```

Nothing is spawned, re-tiered, queued or retried by it. There is no loop: a suggestion is computed once, when the commander assigns.

**Representative assignments.** `tests/routing.test.ts` holds twenty-one assignments of the kinds an engineering session makes, with the tier the route suggests for each. Seven are suggested to Haiku (an inventory, file discovery, a narrow reference search, log classification, a mechanical comparison, a lookup named light, test triage); twelve to Sonnet (tracing a code path, an explorer sent during reconnaissance, an investigation named high, documentation research, three reviews, a feature, a debugging task, a refactor, and two writes that were asked of Haiku); two to Opus. In nine of the twenty-one the suggestion differs from the tier requested: five reads requested of Sonnet that suit Haiku, three tasks requested of Haiku that do not suit it (a review and two writes), and one architecture task requested of Sonnet. In v0.6.0 none of the twenty-one carried a suggestion.

**The funnel is visible.** `/cockpit agents` adds one line per tier that has anything to show, then how many assignments differ:

```text
ROUTE HAIKU · suggested 7 · requested 5 · admitted 1 · spawned 1 · completed 0 · verified 0
ROUTE SONNET · suggested 12 · requested 15 · admitted 0 · spawned 0 · completed 0 · verified 0
ROUTE OPUS · suggested 2 · requested 1 · admitted 0 · spawned 0 · completed 0 · verified 0
  9 assignments differ from the route's suggestion; the commander's tier stands
```

The six figures are six facts and are never merged: *suggested* by the route; *requested* by the commander; *admitted*, a slot and ownership were reserved; *spawned*, the host reported an agent; *completed*, the host reported the end; *verified*, the commander recorded a pass. `/cockpit agents <task>` adds a `route:` line, and `swarm status` returns the same counts under `routing` and each task's `suggested` tier. A task assigned before v0.6.1 has no suggestion: it is counted as unrecorded and shown as "no suggestion recorded", never guessed.

**The instructions say what is true.** The commander's section now says when a Haiku scout or utility suits (a read-only question that is extractive and can be bounded), to assign several in one batch at the start of reconnaissance, to keep interpretation, architecture and risky changes away from Haiku, what a helper can do inside named paths, and that a claim holds the commander's own edits inside it and any running helper holds its shell. The scout, utility, explorer, researcher and reviewer definitions give the Git forms that run under an assignment; the reviewer's no longer says it can run tests there.

## Scoped read-only Git inspection

**What a task with named paths may run.** One command of this form, and nothing else from a shell:

```text
git diff|show|log|status|grep|ls-files [options] [revisions] -- <path inside the scope>…
git show <revision>:<path inside the scope>
```

**The checks, in order.** A command that fails any of them does not reach the host.

1. *One plain command.* No pipe, chain, redirect, here-document, substitution, variable, second line, wrapper (`env`, `sudo`, `xargs`, `timeout`, …), assignment (`GIT_DIR=…`), or other path to Git. The first word is `git` and the second is the subcommand, so no global option (`-C`, `-c`, `--git-dir`, `--exec-path`) fits.
2. *A subcommand from the list:* `diff`, `show`, `log`, `status`, `grep`, `ls-files`.
3. *Every option is on that subcommand's own list*, matched exactly (Git's abbreviations of long options are not accepted). The lists hold display and search options only. Not on any list: `--output`, `-O`, `--ext-diff`, `--textconv`, `--no-index`, `--format`, `--pretty`, `--show-signature`, `-L`, `--follow`, `--full-diff`, `-C` and `--find-copies-harder`, `-f`, `--open-files-in-pager`, `--recurse-submodules`, `--with-tree`, `--exclude-from`, and anything else. An option that takes a value takes a plain one, never the `--`.
4. *Revisions are plain names* (letters, digits, `_ . / ~ ^ @ -`, and `a..b` or `a...b` ranges). A `:` or a brace is refused, because `HEAD:dir`, `HEAD^{tree}` and `:0:path` address trees and files. Each name is then proved to be a commit with `git rev-parse --verify --quiet <name>^{commit}` before anything runs, so an object id of a tree or a file is refused as well.
5. *An explicit `--` and literal paths.* No wildcard, no pathspec magic (a leading `:`), no `~`, no leading dash, at most 32. Each is resolved with `realpath -m` against the verified session directory and must lie inside the task's owned resources. `git show <revision>:<path>` is the one form without `--`: its path is resolved against the repository root and must be owned.
6. *The repository is the session's own, and no clean or process filter is active on its tracked paths,* as for a wildcard inspection.

**What runs is rebuilt.** The agent's text is never executed. The accepted words are written again, each in single quotes, as `git --no-pager <safe flags> -C <verified directory> <subcommand> [--no-ext-diff --no-textconv] <options and revisions> -- <canonical absolute paths>`. The safe flags are the existing ones (`--no-optional-locks`, `--no-replace-objects`, `--literal-pathspecs`, fsmonitor and the untracked cache off, signature display off, a fixed log format). The `-C` pin and the absolute paths mean the read does not depend on the shell's working directory.

**What a scoped reviewer therefore has:** the diff, the history, the content at a revision, the uncommitted state, a text search and a file listing of the paths it owns. **What it does not have:** any other file's content or name, by any spelling (`..`, an absolute path, a parent directory, a tree-ish, an object id, a rename's earlier name); a write; a second program; a `*` scope, which only the commander's assignment gives.

**One thing is repository-wide by nature:** commit metadata. `git log -- <path>` and `git show <commit> -- <path>` print the hash, author, date and message of the commits they list, and a commit's message is not path-scoped. File contents and file names outside the scope are not printed.

**A wildcard task keeps the v0.6.0 rule** (a refusal list over `diff`, `status`, `log`, `show`, `ls-files`, `rev-parse`, `grep`), with two corrections. The `--` separator is accepted, and a word after it that begins with a dash is refused, so no word is left that could be read as an option without having been checked as one. A subagent's single-quoted argument may contain `$`, `<`, `>` or a backtick, since its command is rebuilt before it runs. The commander's own commands run as typed, so nothing quoted in them is taken on trust: that rule is unchanged apart from `--`.

**Native permissions are untouched.** The hook refuses a call or passes it on, changed or not, to the host; it never returns an allow. A rebuilt command still meets Claude Code's own permission rules, and a person who has not allowed `git` is still asked.

**Refusals explain themselves.** For example:

```text
SWARM / name what to read: end the command with "--" and one or more paths inside your scope. Form: git diff|show|log|status|grep|ls-files [options] [revisions] -- <path inside your scope>…. Owned: …/hooks/swarm.ts, …/example/tests.
SWARM / read outside owned resources: …/hooks/alerts.ts is not inside this task's scope (owned: …/hooks/swarm.ts, …/example/tests). A read-only Git command does not widen a scope; ask the commander to assign the path.
SWARM / "--full-diff" is not on the list of options git log may take under a narrow scope (…). Drop it, or ask the commander for a wildcard read scope if the work needs it. Owned: …
SWARM / "deadbeef" does not name a commit here. Under a narrow scope a revision must be a branch, tag or commit id that resolves to a commit; a tree, a file or an unknown name is refused.
```

A command that is not Git at all meets the general rule, which now names the way to search: `SWARM / read-only tasks may use inspection tools only; shell/custom effects require commander investigation. To search or list inside your scope: git grep -n <pattern> -- <path>, git ls-files -- <path>; to read a file: the Read tool.`

**Checked against a real shell and a real Git.** Outside the plugin's test host, seventy-six commands were run through the rules, and each accepted one was executed with bash and git in a throwaway repository that held a secret string in files outside the scope, in a file that had been moved into the scope from outside it, in an untracked file and in the README. Thirty-three ran and forty-three were refused. None printed the secret and none created the canary file that a quoted `$(touch …)`, a backtick, a `; touch`, a pager or an output option would have created. The scoped commands were run from a directory outside the repository, so the `-C` pin carried them.

## Home-directory names

`hooks/paths.ts` now holds one rule, used by the Inspector's free text (`shortenPaths`), by resource claims (`shortResource`, in `/cockpit agents`, the guard's refusals and their scope lists) and by diagnostics that need the whole path (`withoutHomeName`, in `/cockpit doctor`, `/cockpit version` and the guard-trust prompt).

**Recognised: the segment after each of these is a user's name and is never shown.**

| Layout | Where |
|---|---|
| `/home/<name>` | Linux |
| `/var/home/<name>` | Fedora Atomic and other immutable desktops (the v0.6.0 disclosure) |
| `/Users/<name>`, `/Volumes/<v>/Users/<name>`, `/System/Volumes/Data/Users/<name>`, `/System/Volumes/Data/home/<name>` | macOS |
| `/usr/home/<name>`, `/export/home/<name>` | FreeBSD; Solaris and NFS exports |
| `/mnt/<x>/Users/<name>`, `/<letter>/Users/<name>`, `/cygdrive/<letter>/Users/<name>` | WSL, Git Bash, Cygwin |
| `/media/<name>/…`, `/run/media/<name>/…` | removable media mounted per user |
| `~name/…` | another person's home by name |
| `C:\Users\<name>\…`, `C:/Users/<name>/…` | drive-letter paths, either slash |
| `file:///…`, `file://localhost/…`, `host:/…` | the same layouts inside a file URL or after a host |

In free text and in a claim, what lies below the home directory is cut to its last two segments (`/var/home/alice/Projects/app/hooks/a.ts` → `…/hooks/a.ts`; `/var/home/alice` → `…/`). In a diagnostic the path stays whole but for the name (`/var/home/…/.claude/plugins/cache`), or is shown as `~/…` when it is inside the session's own home.

**Left alone on purpose:** the path of a web URL (`https://host/home/alice/x` is a URL, not a path on this machine); a relative path (`hooks/a.ts`, `docs/home/index.md`); a directory merely called `home` or `Users` (`/srv/www/home/index.html` → `…/home/index.html`); ordinary text with slashes, dates, ratios and tildes (`and/or`, `5/10/2026`, `~five minutes`). `~/…` has no name in it and is only shortened.

**Not recognised (the limits).** These are shown like any other path, which means the name can appear:

- a home layout that is not in the table, for example `/data/home/<name>` or `/srv/nfs/home/<name>`;
- a bare `~name` with no slash after it, which cannot be told from ordinary text;
- UNC shares (`//server/share/Users/<name>`, `\\server\share\Users\<name>`);
- a user name with a space in it: the path ends at the space, so the part after it stays;
- a path inside a web URL, deliberately.

This is pattern matching over text. It is not anonymization of arbitrary text and is not described as such anywhere.

**Reviewed and left as they were**, because the documentation already says they hold paths: the Run Ledger's tool entries, `/cockpit ledger`, its JSON export and `/cockpit replay` (PRIVACY.md: "Paths, branch names, ids, repository names and orchestration task text … remain"); a guard refusal that echoes the operand the model typed; and the Mission Control pane's file list, which shows the task's files as recorded.

## The swarm line on the HUD

```text
SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents
```

Shown only while at least one task is in one of three recorded states:

- **BLOCKED**: admission refused it (a dependency that has not completed, a full pool, an ownership conflict). The commander retries when the cause clears, or cancels it.
- **QUIET**: the swarm's `stalled` mark, which means no activity was observed for the stall threshold (five minutes by default, shown as `5m+`). A long model turn with no tool call earns it, and one observed tool call clears it. It is not called stuck or stopped, because silence is not proof of either.
- **ESCALATED**: the agent stopped with a question that the commander has not resolved.

**Not counted:** a queued task (assigned and not yet tried, which is not a problem), a reserved or running one, a completed one whether verified or not, a failed or cancelled one, and a cancellation waiting for the host. With none of the three states present there is no row at all.

**Nothing is timed or inferred in the render.** The line is computed from the Run Ledger that the HUD's render already reads. `markStalled` runs where it always did (on a swarm tool call and when host agents are adopted), so the QUIET count is as of the last of those. No timer, poll, subscription or process was added, the line is never animated, and it is the same in reduced motion. It costs one of the rows the agent strips would otherwise use, and a one-row band does not show it.

**Narrow bands** get the widest form that fits, and the states stay apart until only a total fits:

| Width | Line |
|---|---|
| 62 or more | `SWARM: 2 BLOCKED · 1 QUIET 5m+ · 1 ESCALATED · /cockpit agents` |
| 58 to 61 | `SWARM: 2 BLOCKED · 1 QUIET · 1 ESCALATED · /cockpit agents` |
| 48 to 57 | `SWARM: 2 BLK · 1 QUIET · 1 ESC · /cockpit agents` |
| 31 to 47 | `SWARM: 4 ATTN · /cockpit agents` |
| 13 to 30 | `SWARM: 4 ATTN` |

The widths are for this mix; a line with one state fits its full form from 33 columns. `ATTN` is the sum of the three states only.

Two wordings changed with it. The narrow `/cockpit agents` header said `N stuck` for stalled and escalated tasks together and now says `N stalled · N esc`. The pane's TASK GRAPH row counted stalled tasks as blocked and now reads `blocked N`, with ` · quiet N` and ` · escalated N` added only when they are not zero.

## Compatibility

- **Earlier Ledgers.** `suggestedTier` and `routeReason` are optional. A stored swarm without them loads, admits, runs and completes as before; its tasks are counted as unrecorded in the funnel.
- **`summarizeSwarm`.** `blocked` now counts the `blocked` state only; `stalled`, `escalated` and `routing` are new fields. `swarm status` returns them. Anything that read `blocked` as "blocked or stalled" should add the two.
- **Refusal texts.** The prefixes that tests and agents match (`SWARM / read-only tasks may use inspection tools only`, `SWARM / shell inspection requires declared wildcard read scope`, `SWARM / read outside owned resources`, the repository-identity refusal) are unchanged; text was added after them.
- **Both profiles.** The suggestion, the funnel, the scoped rule and the HUD line are the same in OPUS_LED and SONNET_LED. In SONNET_LED an OPUS task is still admitted only through `consult`.
- **Observation mode.** With `orchestration: false` the swarm guard does not run, so nothing here restricts or rewrites a command.
- **Verification.** A reported result is still not a verified one; `verified` in the funnel counts only the commander's recorded passes.

## Measurements

On the development machine (Bun runtime, mean of at least five hundred calls after a warm-up):

| What | Cost |
|---|---|
| the commander's rule, the wildcard rule, the scoped rule, per command | 7.6 µs, 7.8 µs, 8.2 µs |
| rebuilding a command (wildcard, scoped) | 8.8 µs, 2.1 µs |
| `suggestRoute`, per assignment | 0.17 µs |
| `routingOf` over 512 tasks | 2.8 µs |
| `swarmHint` over 512 tasks, per HUD render; with an empty swarm | 6.0 µs; 0.16 µs |
| `agentsText` over 512 tasks, with the funnel (v0.6.0: 0.16 ms) | 0.20 ms |
| `shortenPaths`, a sentence with four paths; 1,500 characters with none | 4.1 µs; 60 µs |

A scoped inspection runs more host processes than a wildcard one: one `realpath -m` for each path named (0.33 ms each here) and one `git rev-parse --verify` for each revision (0.62 ms each). `git diff main...HEAD -- hooks/swarm.ts` is eight processes where the wildcard form is five, about 1.6 ms more. A command refused for its shape runs none. `tests/scoped-git.test.ts` pins those counts.

## Tests

2,255 tests in 60 files pass (2,161 in 55 before this release). New: `tests/git-inspect.test.ts` (27: the three rules and the rebuild, over several hundred commands), `tests/scoped-git.test.ts` (15: the scoped reviewer through the real tool hook, scope escapes, the revision proof, refusal texts, filters, cancellation, the wildcard rule and the commander's), `tests/routing.test.ts` (15: the twenty-one representative assignments, the invariants, the funnel, an earlier Ledger, the Inspector, the real swarm tool and the pools), `tests/paths.test.ts` (19: each layout, what is left alone, the limits, claims and diagnostics), `tests/swarm-hint.test.ts` (18: each state, clearing, every width from 1 to 140, a 512-task swarm, the real render hook on both surfaces). `tests/inspector.test.ts` changed one expected header.

## Human acceptance (NOT VERIFIED until you do it)

Mission Control, in an interactive session with `orchestration: true`:

1. **The route.** Ask for a task that needs reconnaissance. After the commander assigns helpers, run `/cockpit agents`: a `ROUTE` line per tier with six figures, and `/cockpit agents <task>` shows a `route:` line. If the commander assigned a scout-like read to Sonnet, its `assign` reply carried a `ROUTE / HAIKU suggested` sentence and the task still ran on Sonnet.
2. **A scoped reviewer.** Have the commander assign a reviewer with two or three named files and ask it to review a branch's diff. In the transcript its `git diff <base>...<head> -- <file>` runs, and a `git diff` with no paths, or one naming a file outside its scope, is refused with a `SWARM /` reason that names the scope. If you have not allowed `git`, Claude Code still asks you.
3. **The HUD line.** While a task waits on another (assign B depending on A, start A, try to start B), the band shows `SWARM: 1 BLOCKED · /cockpit agents`. When B is admitted or cancelled the line goes. Narrow the terminal to about 40 columns: it shortens and keeps its count.
4. **No clutter.** With helpers merely running or finished, there is no `SWARM:` row.
5. **Reduced motion.** With reduced motion on, the line looks the same; it never moves.
6. **A home path.** On a machine whose home is `/var/home/<you>`, `/cockpit agents <task>` for a task whose objective names a file under it shows `…/dir/file`, and `/cockpit version` shows `SOURCE / ~/…` or `/var/home/…/…`, without your name.

## Known limits

- A scoped inspection sees tracked files, and untracked ones only through `git ls-files -o`, `git status` and `git grep --untracked`. Ignored files are invisible to it; `Read` still reads any file inside the scope.
- Commit messages, authors and dates are repository-wide (see above).
- Options outside the scoped lists need a `*` scope from the commander, including harmless ones nobody listed.
- A revision name with characters outside the plain set (`+`, `#`, `=`, a brace form such as `@{upstream}`) is refused under a narrow scope; use the commit id.
- A scoped writer still cannot run tests or builds; the shell rule for writes is unchanged, and so is the rule that a writer reads only what it owns.
- The commander's shell is still held while any helper runs, and its edits inside a helper's claim. The instructions now say so; the rule itself is the ownership guarantee and was not relaxed.
- The route reads four structured fields. A read assigned to an explorer during engineering is suggested to Sonnet even when it is a simple lookup; naming it `low` or giving it a scout role is how the commander says otherwise.
- The QUIET count is as of the last swarm call or agent adoption, not of the moment the HUD drew.
- The home-path limits listed above.

## Still NOT VERIFIED

Everything a live session would show and the test host cannot: that a Haiku scout under v0.6.1 completes a search it could not complete under v0.6.0 (this release was built under the installed v0.6.0 guard, so its own scouts ran the old rule); a scoped reviewer in a real session; the HUD line at a real terminal and its redraw when the Ledger changes; the native permission prompt for a rebuilt command; whether a model follows the new instructions or heeds a `ROUTE` suggestion. Also the Anthropic Plugin Directory's verdict on this or any commit, which only the Directory decides.

## Independent review

To be completed when the independent reviews return.
