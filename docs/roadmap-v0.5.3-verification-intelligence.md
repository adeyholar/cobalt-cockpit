# Proposed for v0.5.3: verification intelligence

Status: proposal only. Nothing here is implemented in v0.5.2, and v0.5.2 is not delayed for it. It is separate from the
Stop guard remediation, which stays the priority.

Prior art: the independent open-source project <https://github.com/ismaildasci/claude-referee> motivated the question. No source
code from it is used, and none should be copied. Anything built here is designed from the requirements below.

## Objective

Measure whether Cockpit's completion verification is *accurate*, not only whether its gates ran.

## Proposed pieces

1. **Shadow referee.** A non-blocking mode for evaluating a new verification policy: record what the policy would have done
   without changing actual completion. A probabilistic judgment never overrides a trusted script result, a security review or a
   release approval.
2. **Verification receipts.** Privacy-safe structured facts added to the existing Ledger evidence: check identity, exit code,
   time, task and candidate identity, evidence freshness, policy, known versus unknown coverage, decision and reason code, and
   optionally measured latency or cost. No raw test logs, prompts, code or secrets by default.
3. **Owner feedback.** An authorized person may label an advisory result correct or incorrect. The labels feed false-positive and
   false-negative rates, precision and recall, extra continuation attempts, added time, and the count of unlabelled cases. The
   agent's own completion claim is never taken as a label, and a label cannot manufacture a verification.
4. **Optional second opinion through the existing JEV integration.** Deterministic evidence checks first; JEV only for bounded,
   ambiguous questions and only when explicitly enabled. A model probability is never authoritative. No raw private data leaves the
   machine without informed consent. Option-order sensitivity of multi-option judgments is tested before any result is relied on.
5. **Cost and reliability measurement.** Actual extra model turns and cost where available, kept apart as measured, estimated or
   unknown. No savings claim without a controlled comparison. Results stay local.

## Acceptance criteria

- No change to the existing authoritative security or release gates.
- No second Stop-hook enforcement engine.
- Shadow mode never blocks completion.
- The receipt schema is backward compatible.
- Owner labels cannot manufacture verification.
- No external request by default; explicit privacy controls.
- A real false-positive / false-negative evaluation on labelled fixtures.
- Bounded latency and model-call overhead.
- No feature is added without useful evidence from that evaluation.
