# v0.6.4: Fingerprint resource hardening (security)

> Part of the [Cobalt Cockpit documentation](README.md). Summary: [CHANGELOG](../CHANGELOG.md). Policy: [SECURITY.md](../SECURITY.md#working-tree-measurement-limits).

The working-tree fingerprint decides whether a task's verification still describes the tree: a change made outside Edit, Write and a Bash edit diff withdraws DONE. To take it, Cockpit runs Git and `stat` over the repository at every prompt, tool call and Stop. In v0.6.3 the repository decided what those processes read, and some of what it could make them read had no end. This release bounds every such process, reads nothing that is not an ordinary file, and reports anything it cannot measure safely as UNKNOWN, which never stands for a clean tree or a passed check.

No setting was added. The six gates, goal checking, DONE semantics, the Stop guard, native permissions and the other guards are unchanged, except where an unmeasurable tree used to keep an earlier verification ([below](#an-unknown-never-keeps-a-verification)).

## What was wrong

Three vectors were reported. Each was reproduced with Git 2.43 in disposable repositories, running the exact argument vectors v0.6.3 used, under an address-space limit of 2 GiB, 10 s of CPU, a 16 MiB file-size limit and a SIGKILL after 8 s.

| Vector | v0.6.3 step | Result under the limits |
|---|---|---|
| An untracked symbolic link to `/dev/zero` | `hash-object --no-filters -- <path>` | memory exhausted: 1.7 GB in 846 ms |
| An untracked link to a FIFO | the same | blocked until killed |
| `core.excludesFile = /dev/zero` | hashing the excludes source | memory exhausted |
| `diff.orderFile = /dev/zero` | `diff <head> --name-only` | memory exhausted in about 0.46 s |
| `core.attributesFile = /dev/zero`, or `.git/info/attributes` linked to it | `diff`, `check-attr` | memory exhausted in about 0.25 s |
| `objects/info/alternates` linked to `/dev/zero` | `ls-tree` | memory exhausted (1.46 GB) |
| A linked worktree whose `commondir` is linked to `/dev/zero` | `rev-parse --show-toplevel` | memory exhausted |
| A FIFO as `.gitignore`, `.gitattributes`, `core.excludesFile`, `HEAD`, the index or `config` | listing, attributes, identity | blocked until killed |
| A 200 MB regular excludes file | `ls-files -o` | 342 MB resident, in proportion to the file |

Read in the same experiment, and harmless: `info/exclude`, `packed-refs`, `sparse-checkout` and `shallow` linked to `/dev/zero` (Git reads them by their size, which is 0), `include.path = /dev/zero` (rejected at once as a bad config line), and `stat` and `readlink` on links and FIFOs, which open nothing.

**Why the timeout did not help.** The host's `process.run` ends a child at its timeout (6 s for Cockpit's Git calls) and caps each output stream at 4 MiB. Neither bounds memory: a process reading `/dev/zero` into a growing buffer reached 14 GB in 5 s on this machine, long before any timeout, and the output cap counts what the process writes, not what it reads. A FIFO costs no memory but holds the call for the whole timeout, at every prompt and Stop. Before this release, a timeout was the only bound.

## The design

Four layers, so that no single missed case is unbounded where the platform allows a real limit.

### 1. Every measurement process starts under kernel limits

Each `git`, `stat`, `find`, `readlink` and `realpath` that the fingerprint, the HUD refresh, the release check and the preflight of a helper's Git inspection start goes through `bounded` (`hooks/register.tsx`). It runs one fixed script:

```sh
sh -c 'lower() { c=$(ulimit "$1") || return 1; if [ "$c" = unlimited ] || [ "$c" -gt "$2" ]; then ulimit "$1" "$2"; fi; } && lower -v 1048576 && lower -t 20 && lower -f 131072 && lower -c 0 && exec "$@"' cockpit-bounded git …
```

| Limit | Value | Why |
|---|---|---|
| Address space (`-v`) | 1 GiB, wherever the shell accepts it (setting a limit a platform ignores is harmless) | ends a read without bound within about 0.2 s where it is enforced (measured) |
| CPU time (`-t`) | 20 s | a backstop; the host's timeout normally ends a process first |
| File size (`-f`) | 64 MiB (131072 blocks of 512 bytes; 128 MiB in a shell that counts 1024) | no measurement writes a file; not 0, because a host that captured output through a file would lose every measurement (measured) |
| Core dumps (`-c`) | 0 | a crash must not write a core into the working tree |
| Time | the host's timeout, 6 s per Git call; 90 s per fingerprint | unchanged per process; the fingerprint deadline is new |

The script is a constant. The command's words follow its `$0` (`cockpit-bounded`) as separate arguments and are run by `exec "$@"`: no word of a command is ever part of the script, so nothing a repository names can be read as shell. `lower` never raises a limit: a host or container whose limit is already stricter keeps it. (A first version used plain `ulimit`, which tries to set the hard limit too; under a stricter outer limit every `ulimit` failed, measured, and the probe would have fallen back to running unbounded.)

Git gets settings that keep a legitimate command inside the cap: `core.hooksPath=/dev/null`, `diff.orderFile=/dev/null`, `core.packedGitWindowSize=32m`, `core.packedGitLimit=256m`, `core.deltaBaseCacheLimit=64m`, `core.bigFileThreshold=16m` (files above it are hashed as a stream), `core.preloadIndex=false` and `index.threads=1`, with `MALLOC_ARENA_MAX=2` in its environment. Without them some ordinary commands failed under a 512 MiB cap ("unable to create threaded lstat"); with them every fingerprint command ran at 384 MiB on a packed 20,000-file repository, peaking at 18.6 MB. Behind `sh`, the host's own handling of `git` (it turns repository hooks off) no longer applies, so Cockpit sets `core.hooksPath` itself. The diff order file is overridden because the order of a listing never matters here; the excludes and attributes files are not overridden, because they decide what "untracked" and "filtered" mean.

**The probe.** Once per load, `probeBound` runs three fixed scripts: the limits followed by `echo set`; a single 64 MiB `dd` from `/dev/zero` to `/dev/null` without a cap, which must succeed; and the same under a 32 MiB cap, which must fail. If the shell accepts `ulimit -v`, the script with the memory limit is used, whether or not the platform enforces it, and the two `dd` runs only decide what `/cockpit doctor` says: `OK` when the cap is enforced, `WARN` when it is not. A shell that refuses `ulimit -v` gets the script without it (CPU, file size, core); no usable `sh` means processes run directly, under the host's timeout. A probe that does not answer (a timeout under load, a shell that cannot start) stands for 30 s and is then run again: one slow moment cannot lower the rest of a session, and a host with no shell does not pay two failed starts for every process. A shell that answers the plain probe but not the memory one is taken to be slow and keeps the memory limit. On this machine (Linux 6.8, dash) and in a genuine Claude Code 2.1.299 process the cap is enforced. macOS was not available to test; its `ulimit -v` is not expected to be enforced.

### 2. Nothing that is not an ordinary file is read

`inspectPaths` runs `stat` before anything is read: GNU `--printf '%f %s %i %.9Y %.9Z %n\0'`, BSD `-f '%p %z %i %m %c'` as the fallback. Each record gives the raw mode, the size and an identity (mode, size, inode, modification and change times). GNU records carry the name asked for, so when some paths in a batch are missing the others still count. When every error line is "No such file or directory" and there is one for each path not answered, those paths are missing with no further call; otherwise only they are asked again, one at a time. An error is read by the words that end its line, after the path, so a file named to look like "No such file or directory" cannot pass for a missing one. `stat` without `-L` opens nothing: on a link it reports the link; on a FIFO or device, its kind. A directory link in the middle of a path is followed, as by Git, but that cannot lead to a read without bound: Git hashes a regular file by the size `fstat` gives it (a size-0 file under `/proc` hashes as empty; measured), and every other kind is refused.

| Path | What is read |
|---|---|
| A regular file | its bytes, by `hash-object --no-filters`, if within the size bounds |
| A symbolic link | its text, by `readlink -z`: what Git records for a link. The file it leads to is never read |
| A FIFO, socket, character or block device | nothing: its kind and permission bits go into the fingerprint |
| A directory among changed or untracked paths (a nested repository) | nothing: UNKNOWN |
| A path gone between the listing and the inspection | UNKNOWN |
| A tracked path that is now a FIFO, socket, device or directory | UNKNOWN, as before |

Watched paths and the verifier script are inspected through a link (`-L`), because the operator named them: a regular file is hashed, a directory listed, a missing path is `none`, and anything else is UNKNOWN.

**Changes during the read.** Files are inspected, read, then inspected again; a different identity is UNKNOWN ("a file changed while it was being measured"). This catches a file replaced by a link to a device between the two steps. Where the memory cap is enforced, the read itself also ends at the cap. The release check's second read (`matchesCommit`, with normalization) is guarded the same way. A measurement that failed only for such a race (an identity that changed, a listed file that vanished, an ignored entry whose only error was that it vanished) is taken once more before an accepted goal check or a passing check is judged by it (`settledStamp`): a tree in use (an editor's swap file, a watcher's output) is not called unmeasurable for one unlucky moment. A second failure stands. BSD `stat` gives times to the second, so there a same-size rewrite within one second can escape the identity check; the hash then differs, which reads as a change, never as unchanged.

### 3. Git's whole-file inputs are checked before Git runs

`gitInputs` asks Git where its excludes, attributes and alternates files are (`rev-parse --git-path info/exclude --git-path info/attributes --git-path objects/info/alternates`, `config --type=path --get core.excludesFile`, the same for `core.attributesFile`) and inspects them through a link. Each must be an ordinary file of at most 1 MiB, or absent. Anything else is UNKNOWN, with the setting and the kind named ("core.attributesFile is a character device, not an ordinary file; Git would read it without bound, so the working tree is not measured"). The check runs before every Git command that would read them: in the fingerprint, the HUD refresh, the release check and the preflight of a helper's Git inspection. A setting Git cannot report (as opposed to one that is not set) is UNKNOWN too; before, it was read as "not set". Both `diff` calls also pass `-O/dev/null`.

What is deliberately not pre-checked, because the list cannot be closed (include files, nested attributes in every directory, a worktree's `commondir`): those are left to the kernel limits, with the consequence for `partial` platforms stated [below](#residual-risks).

### 4. Every limit ends in UNKNOWN, with the reason

| Bound | Value | UNKNOWN reason (abridged) |
|---|---|---|
| One file read | 1 GiB | a file is larger than 1 GiB |
| All files read by one fingerprint | 8 GiB | the working tree holds more than 8 GiB to read |
| An excludes, attributes or alternates file | 1 MiB, regular | `<setting>` is larger than 1 MiB / is a FIFO… |
| Changed, untracked and flagged files | 20,000 | unchanged from v0.6.3 |
| Tracked files; ignored and watched files | 100,000 each | unchanged |
| Output of one process | 4 MiB (host) | cut short |
| One fingerprint | 90 s overall; 25 s each for tracked and ignored files | took longer than 90 s |
| One process | 6 s (host), 20 s CPU, 1 GiB | failed, timed out or reached a resource limit |

A fingerprint's reason is captured when it is taken and carried into the record that uses it: the Stop guard's check record, the refusal of a goal check, the note on an unprotected one. A stored fingerprint's commit is passed back to Git only if it is a full commit id.

### The stamp's hash

The fingerprint is `<commit>:<lines>.<digest>@<project>`. The digest was two 32-bit FNV-1a hashes; the lines it covers include file names, link texts and kinds, which whoever writes the tree chooses, and a fast non-cryptographic hash of 64 bits lets a chosen change be made to keep the earlier value, so a changed tree would read as unchanged. It is now SHA-256 of the lines, cut to 128 bits. The longest stamp is 140 characters, inside the stored bound of 160.

### Helper Git inspection

A helper's read-only Git command is rebuilt by Cockpit and then run by Claude Code's Bash tool, so Cockpit's limits do not apply to it. It now carries `core.hooksPath=/dev/null` and `diff.orderFile=/dev/null` as well as the flags it had, and its preflight runs `gitInputs` before the filter check.

## An UNKNOWN never keeps a verification

The consumers were audited for every place a fingerprint that cannot be taken (`null`) is read. No comparison treats two UNKNOWNs as equal. Three places let an unmeasurable tree keep a verification made on a measured one; they are fail-closed now (`hooks/model.ts`: `treeUnmeasured`, `checkedAt`'s `unmeasured` reason, `unmeasuredWhy`):

| Where | v0.6.3 | v0.6.4 |
|---|---|---|
| A goal check accepted (ALIGNED) on a measured tree, then the tree cannot be measured | kept, so DONE stood | withdrawn: the goal check and the passed checks are pending again, "the working tree can no longer be measured (…)" |
| `align` when the checks were observed on a measured tree that cannot be measured now | accepted, with the "unprotected" note | refused, with the reason; the checks are pending |
| A passing command seen on an unmeasurable tree, after checks observed on a measured one | the earlier passes stood | they are pending again; the new result is recorded |

A transient failure (a Git call that timed out) counts the same: it is not evidence that the tree is unchanged. Once the checks are run again on the unmeasurable tree, `align` is accepted and its note now says why no fingerprint could be taken. A task whose tree was never measurable keeps the behaviour documented since v0.5: ALIGNED is accepted as unprotected, and only Edit, Write and Bash edit diffs can withdraw it. The Stop guard already refused to record a pass on a tree it cannot identify, and still does.

Pre-existing and unchanged, documented here as residuals: checks passed on a tree that was never measured carry no tree to compare against; and a Stop with no task while filters make the tree unreliable reads as nothing to check under `ENFORCE`.

## Measurements

The v0.6.4 argument vectors against the same vectors and against ordinary repositories, in disposable repositories under an outer net (address space 2 GiB, CPU 15 s, file size 16 MiB, SIGKILL after 6 s); the plugin's own script sets its 1 GiB cap inside:

| Case | Result | Time | Peak resident |
|---|---|---|---|
| `hash-object` through a link to `/dev/zero` (what a swap mid-read could still cause) | ends at the 1 GiB cap | 181 ms | 764 MB |
| `diff.orderFile = /dev/zero`, v0.6.3's `diff` with v0.6.4's Git settings | completes: the override alone suffices | 3 ms | 5.4 MB |
| the same with `-O/dev/null` too, as v0.6.4 runs it | completes | 4 ms | 5.4 MB |
| the same with no override at all | ends at the cap | 202 ms | 917 MB |
| `core.attributesFile = /dev/zero`, `check-attr` | ends at the cap | 143 ms | 529 MB |
| `alternates` to `/dev/zero`, `ls-tree` | ends at the cap | 240 ms | 973 MB |
| linked worktree, `commondir` to `/dev/zero`, `rev-parse` | ends at the cap | 197 ms | 916 MB |
| FIFO `HEAD` or `.gitignore` | killed at the 6 s timeout | 6.0 s | 2 MB |
| a clone of this repository, its linked worktree and a subdirectory: every fingerprint step | completes | at most 12 ms each | at most 6.3 MB |
| a sparse 300 MB untracked file | streamed and hashed | 908 ms | 4.9 MB |

In those runs no fingerprint step reaches the memory cap. In a genuine Claude Code 2.1.299 process, run with immediate `/cockpit` commands in a user cgroup scope (memory 2 GiB, no swap, CPU quota, CPU-time and file-size limits), `/cockpit doctor` reported `full`, and a Git shim first on `PATH` recorded each of Cockpit's Git processes running with an address-space limit of 1073741824 bytes, CPU 20 s and file size 67108864 bytes. A project holding an untracked link to `/dev/zero` and `core.excludesFile = /dev/zero` peaked at 298 MB for the whole Claude Code process, as an ordinary project did.

## Compatibility

- **The stamp's hash changed**, so every task that spans the upgrade sees its tree as changed once and asks for one more check.
- **Symbolic links among changed and untracked files** are measured by their target text, not by the content of the file they lead to. Editing the file a link leads to is seen when that file is itself in the tree.
- **A global ignore or attributes file over 1 MiB**, one Cockpit cannot read (Git only warns and skips it), or one that is a FIFO or a device, makes the fingerprint, the HUD's Git line and the release check UNKNOWN until it is an ordinary readable file. The HUD then shows the project as not a repository, as it already did for an active external filter, and a session's starting commit is taken afresh when the repository reads again.
- **Large files.** A tracked or untracked file over 1 GiB, or more than 8 GiB to read, makes the fingerprint UNKNOWN on every measurement. v0.6.3 hashed such files where its 6 s timeout allowed. A goal check is then accepted as unprotected, with the reason.
- **An accepted goal check is withdrawn** when the tree can no longer be measured, including for a timeout. A race is measured once more first ([above](#2-nothing-that-is-not-an-ordinary-file-is-read)).
- **A Git configuration that cannot be read** is UNKNOWN; it used to be taken as "no such setting".
- **More processes.** `stat` runs where only Git ran, and each fingerprint adds about four (Git's whole-file inputs, the inspection before and after reading). A deleted tracked file now costs one extra `stat`, where v0.6.3 re-inspected a whole chunk of 400 paths one at a time.
- **The host's Git handling** no longer applies to Cockpit's own Git calls, which now start with `sh`. Cockpit turns repository hooks off itself, and the Git commands it runs read only.
- **`/cockpit doctor`** has a new line under HOST.

## Residual risks

- **No enforced memory cap.** Where the memory limit is not enforced (expected on macOS, not verified), a file Git reads on its own is bounded only by CPU time (20 s; with no shell, not at all) and the host's timeout: a linked worktree's `commondir`, `HEAD` or a ref linked to a device, a configuration include, `info/grafts`, `info/sparse-checkout`, the `info/alternates` of an alternate store; and a file swapped for a device in the moment between its inspection and its read. Each needs write access to the repository's `.git` directory or the working tree while Cockpit measures, which is to say the ability to run a program as you anyway. `/cockpit doctor` says so. Pre-checking those files without Git was considered and left out: the list cannot be closed (includes and nested attributes have no end), and `rev-parse` reads `commondir` before anything could be checked.
- **A tree that was never measurable reaches ALIGNED** as unprotected, with the reason in the reply (documented since v0.5; the Stop guard, where enforcing, still refuses to record a pass on it). Refusing ALIGNED there would make DONE unreachable outside a Git repository; refusing it only for a repository that cannot be measured is an owner decision left open.
- **Helper Git commands** run in Claude Code's Bash tool without Cockpit's kernel limits; the order-file override covers the vector measured there, a configured `mailmap.file` is not overridden.
- **Blocking within the timeout.** A FIFO Git opens itself (`HEAD`, the index, a nested `.gitignore`) still holds each Git call for the host's 6 s, after which the tree is UNKNOWN. That is bounded, not avoided.
- **Claude Code's own Git commands**, and Git commands a model or helper runs through Bash, are outside Cockpit and are not bounded by it.
- **The host's internal capture of output** is not documented. The file-size limit is 64 MiB rather than 0 so that measurement works whether the host reads output through a pipe or a file.
- **Pre-existing:** checks passed on a tree that was never measured have no tree to compare, and the unprotected ALIGNED of a never-measurable tree stands (both documented since v0.5).

## Tests

`tests/fingerprint-bounds.test.ts` (74 tests) covers the limit script and its probes in each mode, including a probe that does not answer; the three reported vectors and the configuration sources (excludes, attributes, alternates, order file, a 200 MB global ignore file, a configuration that cannot be read); FIFO metadata and timeouts; tracked paths turned into FIFOs, sockets, devices and directories; sizes, totals, truncated output, a hashing timeout and the 90 s deadline; files swapped during the read, including in the release check; the fail-closed rules for ALIGNED, `align` and the auto-recorded gates; a race measured once more and one that does not settle; a file named like an error, in a batch and in a nested repository's listing; a batch that mixes missing and unreadable paths; GNU `stat -f` answering for BSD's form; the cost of many deletions; a linked worktree's Git files; the stamp's shape; and ordinary repositories (clean, modified, deleted, untracked, tracked and untracked links, a subdirectory session, BSD `stat`, the HUD refresh). Every hazard has a control that still measures. Run against v0.6.3, 54 of the 74 fail; those that pass there are controls, pure checks of the constants, the timeouts v0.6.3 already treated as UNKNOWN, and two whose hazard v0.6.3 happened to read as a change.

`tests/world.ts` (the test host) records a command started through the limit script as the command itself, with the script beside it, answers the probes by a `boundMode` setting (default `full`, so every other test runs wrapped), and models typed `stat` (`kinds`, `followKinds`, `sizes`, `inodes`, `mtimes`, `linkTargets`, `statFlavor`), `readlink`, truncated Git output and `rev-parse --git-path` answering relative to the work tree, as Git does (`gitPathBase` for a linked worktree's absolute answer). Its ignored-entry `stat` now prints the real five fields. Tests in five earlier files changed: the ignored-file budget test delays only the ignored-entry `stat` (it delayed every `stat`); the no-network test admits the inspection `stat` and checks that every process ran under the script; the scoped-inspection cost test counts the input check (one `rev-parse`, two `config`, one `stat`); the telemetry test allows only the inspection `stat`, where it allowed none; and the rebuilt helper commands in `tests/git-inspect.test.ts` and `tests/scoped-git.test.ts` carry the two overrides. The full suite: 2708 tests.

## Review record

Two independent reviews read commit 891c753 against the base, with no part in writing it: a security review of the whole input chain and a correctness and compatibility review. Both answered GO: no path found exhausts host resources, blocks past a process timeout, or reports a clean, verified or DONE result on a failed measurement. What they raised, and what was done:

| Raised | Done |
|---|---|
| The stamp's 64-bit FNV hash can be made to collide by chosen names: a changed tree could read as unchanged | SHA-256, 128 bits ([above](#the-stamps-hash)) |
| A helper's rebuilt Git command lacked the diff order file override | added, with hooks off |
| `/cockpit doctor` overstated the protection where the memory cap is not enforced | reworded; the files Git reads on its own are named, here and in SECURITY.md |
| A probe that did not answer (a timeout under load) was kept for the whole session, lowering protection | not kept; the memory limit is set wherever accepted |
| A race (a file changing while read) withdrew an accepted goal check | measured once more first; a second failure stands |
| "No such file or directory" was matched anywhere in `stat`'s error, which contains the path | read at the end of the line only |
| Every missing path in a batch cost one more process | answered from the batch when every error is that one |
| GNU `stat -f` in the ignored-entry fallback is another command | each record must be the form asked for |
| A stored stamp's commit went to Git unchecked | only a full commit id |
| The telemetry test no longer forbade any `stat` | it forbids every `stat` but the inspection's |
| The test host answered `--git-path` absolutely, had an attributes file by default and no time races | relative answers, absent by default, an mtime-only test |
| Size caps, unreadable sources and the HUD's state make some repositories UNKNOWN that v0.6.3 measured | kept, fail-closed; [documented](#compatibility) |
| An always-unmeasurable tree still reaches ALIGNED as unprotected | pre-existing and documented; an owner decision ([residual risks](#residual-risks)) |
| A directory link mid-path; BSD's one-second times | checked: Git hashes regular files by `fstat` size; BSD documented |

A third independent review read the corrections (commit bd5b6ae) and answered GO. It raised four low points, all changed before the candidate: an unanswered probe was retried for every process on a host with no shell (now after 30 s); a half-answered probe could run one call without the memory limit (it keeps it now); a timeout was retried as if it were a race (only identity changes and vanished entries are); and the telemetry test had lost its check on the telemetry path (restored). It also named corrections no test would catch if reverted; tests now cover the stamp's shape, a mixed batch, the ignored-entry form and the nested-repository listing. A stored stamp's commit check is covered by code review only.

## Acceptance procedure

For a person, in a disposable project, with no payload that can run without bound. Nothing here reads `/dev/zero` or `/dev/urandom`, writes into a FIFO, or touches a repository you care about.

The observable is the progress tool's own reply to a goal check: on a tree that cannot be measured it ends with "No working-tree fingerprint could be taken here (<reason>), …", and on a measured tree it has no such note. In each step below, ask Claude: *"With the cockpit progress tool: plan one milestone, discover one criterion, complete the milestone, record every gate as na with evidence 'acceptance', then align with that criterion, and show me the align reply."*

1. Make a disposable repository: `mkdir /tmp/cockpit-accept && cd /tmp/cockpit-accept && git init -q && printf 'a\n' > a.ts && git add a.ts && git -c user.email=t@example.invalid -c user.name=t commit -qm a`.
2. Start Claude Code in it with this plugin loaded (`claude --plugin-dir <this checkout>`) and run `/cockpit doctor`. Expect an `OK` line under HOST: "working-tree measurement runs under kernel limits: memory 1024 MiB, CPU 20 s, …". On macOS a `WARN` line is expected; note what it says.
3. A link is measured by its text, never followed: in another terminal, `ln -s /dev/null link-null`. Run the goal check. Expect ALIGNED with no "No working-tree fingerprint" note. (`/dev/null` reads as empty, so this step is safe even for a tool that follows the link.)
4. A configured excludes file that is a device: `git config core.excludesFile /dev/null`. Run the goal check. Expect the note to name "core.excludesFile is a character device, not an ordinary file". Undo with `git config --unset core.excludesFile`.
5. A large global ignore file: `python3 -c "print('x\n' * 1000000)" > big.ignore` (2 MB), `git config core.excludesFile "$PWD/big.ignore"`. Expect "core.excludesFile is larger than 1 MiB". Undo as above and remove the file.
6. A file over 1 GiB that is never read: `truncate -s 1100M big.bin` (sparse: no disk is used). Expect "a file is larger than 1 GiB". Remove it.
7. Fail-closed: with nothing of steps 4 to 6 in place, run the goal check and ask Claude to call the progress tool with action `status`; expect `DONE 100%`. Then `git config core.excludesFile /dev/null` and ask for the progress tool's `status` again (the tool measures the tree before it answers). Expect DONE withdrawn: the task below 100% with its goal check pending. Undo the setting.
8. Remove the directory when done.
