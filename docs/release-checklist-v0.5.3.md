# v0.5.3 release gates

Every attestation identifies the complete candidate SHA. Historical green checks do not cover later changes. Record final results beside the exact Git archive, including its SHA-256, without modifying the tested commit afterward.

| Gate | Required evidence |
| --- | --- |
| Tests | Full host suite with zero failures; adversarial Git identity and refusal-recovery tests included |
| Strict validation | Project, plugin manifest, marketplace manifest, agents and extracted archive |
| Supported-host TypeScript | `scripts/typecheck-host.sh`, clean candidate, actual Claude Code 2.1.296 declarations and TypeScript 5.9.3 |
| Build/package | Source archive, manifest version 0.5.3, exact-file/mode identity and entrypoints via `scripts/check-submission.py` |
| Public audit | `scripts/audit-public.py` on source and archive |
| Secrets | `scripts/scan-secrets.sh`, pinned Gitleaks 8.30.1, history and working tree |
| Git | Whitespace checks and clean working tree; remote candidate SHA verified |
| Remote CI | GitHub CI and Secret Scan on the final candidate SHA |
| Interactive acceptance | Fresh SENT delivery observed by a person and security guard behavior on the exact candidate; test mocks and historical acceptance are separate evidence |
| Independent security | Reviewer has complete source/artifact access, diff, fixtures and genuine host declarations; GO and no unresolved HIGH/CRITICAL |
| Submission | Local artifact checks plus actual external directory report resolving known findings; local validation does not establish external approval |

Source inventory, process disclosures and policy questions are in [submission-compliance-v0.5.3.md](submission-compliance-v0.5.3.md). External portal validation and policy interpretation remain unverified until actual evidence is received. Large source and bundled WAV files remain disclosed manual-review holds.

The owner has authorized engineering, committing, pushing and requesting independent reviews. Merge, annotated tag and publication are authorized only after all gates pass. Anthropic directory submission requires separate authorization. A blocked or NO-GO candidate must not be merged, tagged or published. v0.5.2 must remain unchanged.

Known limitations: fingerprints are bounded change detectors, not atomic filesystem snapshots; nested submodule contents are UNKNOWN; refusal persistence has no cross-process compare-and-swap and cannot survive an unavailable durable store with stronger guarantees. Persistent Alerts are outside this release.
