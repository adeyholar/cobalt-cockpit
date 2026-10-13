# Security follow-ups recorded after v0.6.1

Status: recorded, not designed and not implemented. Neither item is part of v0.6.1. That release fixed the three faults its review reproduced ([Corrections to earlier rules](implementation-v0.6.1.md#corrections-to-earlier-rules)) and changed neither of the things below. Each needs its own design, review and tests before any code.

## P0: a guard that throws refuses nothing

**Where.** `hooks/register.tsx`, in the `tool.call` hook:

```ts
// a guard that fails must not take every tool call down with it
const refusal = await guard($, call).catch(() => null)
```

**What `guard` covers.** For a shell command: the attribution guard, the instruction-file guard and the destructive-command guard with its confirmation. For Edit, Write and NotebookEdit: the attribution guard.

**The risk.** Any exception inside `guard`, from any cause, becomes "no refusal": the call goes on to the host as if the guard had passed it. v0.6.1 removed the one cause that was found (a program named like an inherited property made `unwrap` throw, so `valueOf -x; git push --force` was not asked about). The handling itself is unchanged. The next fault of that kind, in the shell reader, in a rule or in the confirmation, would fail open in the same way, and an input that can make the guard throw is an input that can switch it off.

**It is not what the policy says.** SECURITY.md, "Hooks that refuse": "A hook of Cockpit's that fails is not allowed to let an action through." The outer handler of `tool.call` does refuse when the hook as a whole fails. This inner catch does not.

**Why P0.** It is the destructive-command guard, it applies with orchestration on or off, and the failure is silent: nothing tells the person that a guard did not run.

**What a fix has to decide.**

- What a failed guard does to a shell command: refuse it, or put the question to the person.
- What it does to an edit, where the guard that failed is the attribution check.
- How the person learns that a guard failed, and how a session is not left unable to run anything.
- Whether the same shape exists elsewhere: every catch, `quiet(…)` and `hush(…)` around something that can refuse.

**Acceptance.** A test makes each part of the guard throw and shows that the call does not reach the host unasked. A call the guard would have passed still passes when nothing throws. SECURITY.md's sentence is true of the code.

## Security design: a read claim that cannot be kept narrow becomes the whole repository

**Where.** `canonicalIn` in `hooks/register.tsx` and `normalizeOwned` in `hooks/swarm.ts`. An `owned_resources` entry that contains `* ? [ ] { }`, starts with `~`, or that `realpath -m` does not resolve becomes `*`. An empty list is `*`.

**The risk.** `*` is the conservative reading for a lock: a writer whose claim is unclear locks everything. For a reader it is the opposite. A helper the commander meant to confine may read the whole repository, and with `*` it is judged by the wider Git rule. A real path with brackets in it, such as `app/[id]/page.tsx`, cannot be claimed narrowly at all. On a host whose `realpath` has no `-m`, every named claim would widen; no such host has been checked.

**What v0.6.1 did.** It did not change the behaviour. The reply to `assign` now says when a claim became `*`.

**What a design has to decide.**

- Whether a read claim that cannot be kept narrow is refused instead of widened.
- Whether write claims keep the conservative lock.
- How a literal path that contains pattern characters is claimed.
- What happens where `realpath -m` is not available.
- What sessions and Ledgers that already hold widened claims do after the change.

**Acceptance.** No reader receives `*` unless the commander wrote `*`. The commander is told why a claim was refused and what to write instead. Writers' locking is no weaker than it is today.
