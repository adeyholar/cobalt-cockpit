# Development

> Part of the [Cobalt Cockpit documentation](README.md). This text was moved here from the root README when the README was restructured for v0.6.0; the wording is unchanged unless a sentence says otherwise. Overview: [Contributing](../README.md#contributing).

Load the folder once in an interactive session (`claude --plugin-dir /path/to/cobalt-cockpit`, folder trusted by you) so the host writes its API declarations; a headless launch does not write them on Claude Code 2.1.295 or later. CI runs strict validation, the offline tests, the public audit and the whitespace check on Claude Code 2.1.296 but does **not** type-check: `scripts/typecheck-host.sh` is the mandatory manual TypeScript gate for a release ([docs/release-checklist-v0.5.3.md](release-checklist-v0.5.3.md)). TypeScript 5.9.3 is the pinned compiler; Python 3 runs the portability audit. The suite's default host version is 2.1.288, and the native-effort and directory-validation paths are exercised at 2.1.294.

```sh
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict agents
claude plugin test .
scripts/typecheck-host.sh    # needs host-generated declarations; refuses otherwise
python3 scripts/audit-public.py
python3 scripts/make-icon.py    # re-render the listing icon from the HUD portrait
```

To develop under Auto mode, launch with `scripts/dev-launch.sh`, which loads an out-of-tree snapshot of the plugin and refuses to start if the snapshot is empty or overlaps the repository. An empty `--plugin-dir` resolves to the working directory and makes Claude Code protect the repository from Auto-mode edits. Root cause, preflight and the release acceptance procedure: [docs/development-auto-mode.md](development-auto-mode.md).

All fixtures are synthetic. Test with an isolated HOME/config/state directory. Do not use a real telemetry ledger or private session capture in fixtures.

## README media

The banner, the module keys and the demo animation are generated, not drawn by hand, and the demo is captured from the plugin's own code. What each file is, what is genuine and what is presentation, and how to regenerate them: [assets/README.md](assets/README.md).
