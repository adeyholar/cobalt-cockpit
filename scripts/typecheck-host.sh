#!/usr/bin/env bash
# Mandatory manual TypeScript gate for a release candidate (CI cannot run it: Claude Code 2.1.296 has no verified
# unattended generator for the plugin host declarations).
#   scripts/typecheck-host.sh
# Requires, on this machine:
#   - Claude Code 2.1.296 (CLAUDE_BIN overrides the binary), and
#   - the host's own declarations in .claude-plugin/types/, written by that host when a person loaded this folder in an
#     interactive development session (`claude --plugin-dir <this folder>`, folder trusted by you).
# It never creates, downloads or edits declarations, copies credentials or touches trust settings. The exit code is tsc's.
set -uo pipefail

HOST_VERSION=2.1.296
TS_VERSION=5.9.3
root=$(git rev-parse --show-toplevel) || { echo "typecheck-host: not a git work tree" >&2; exit 2; }
cd "$root"

sha=$(git rev-parse HEAD)
dirty=$(git status --porcelain | wc -l | tr -d ' ')
bin=${CLAUDE_BIN:-claude}
report() { printf 'TYPECHECK REPORT\n  release sha: %s\n  working tree: %s\n  host: %s\n  typescript: %s\n  outcome: %s\n' "$sha" "$([ "$dirty" = 0 ] && echo clean || echo "DIRTY ($dirty paths)")" "${host:-unknown}" "$TS_VERSION" "$1"; }
refuse() { echo "typecheck-host: $1" >&2; report "REFUSED (not a pass)"; exit 2; }

host=$("$bin" --version 2>/dev/null | head -1) || true
case "$host" in "$HOST_VERSION "*) ;; *) refuse "Claude Code $HOST_VERSION is required, found: ${host:-none}" ;; esac

types=.claude-plugin/types
for f in tsconfig.json claude-code/index.d.ts claude-code-tools/index.d.ts claude-code-mcp/index.d.ts; do
  [ -s "$types/$f" ] || refuse "missing or empty host declaration $types/$f; load this folder once with an interactive 'claude --plugin-dir' session"
done
head -1 "$types/claude-code/index.d.ts" | grep -qF "Written by Claude Code $HOST_VERSION." \
  || refuse "declarations were not written by Claude Code $HOST_VERSION (first line: $(head -1 "$types/claude-code/index.d.ts"))"

npm exec --yes --package="typescript@$TS_VERSION" -- tsc -p .
rc=$?
if [ "$rc" = 0 ]; then report PASS; else report "FAIL (tsc exit $rc)"; fi
exit "$rc"
