#!/usr/bin/env bash
# Runs the local capability-shape check (scripts/check-capability-shape.mjs) over the hooks modules with a pinned TypeScript.
# A local approximation of the Anthropic Plugin Directory's capability-inspection guidance: a pass here is not the Directory's
# verdict. Exit 0: no finding. Exit 1: findings. Exit 2: could not run.
#   scripts/check-capability-shape.sh
set -uo pipefail
TS_VERSION=5.9.3
root=$(git rev-parse --show-toplevel) || { echo "check-capability-shape: not a git work tree" >&2; exit 2; }
cd "$root"
npm exec --yes --package="typescript@$TS_VERSION" -- bash -c '
  ts="$(dirname "$(realpath "$(command -v tsc)")")/../lib/typescript.js"
  node scripts/check-capability-shape.mjs --self-test --typescript "$ts" || exit 1
  status=0
  for f in hooks/*.ts hooks/*.tsx; do out=$(node scripts/check-capability-shape.mjs "$f" --typescript "$ts" 2>&1); rc=$?; if [ $rc -ne 0 ]; then printf "%s\n" "$out"; [ $rc -gt $status ] && status=$rc; fi; done
  [ $status -eq 0 ] && echo "check-capability-shape: no findings in hooks/ (a local approximation, not the Directory validator)"
  exit $status'
