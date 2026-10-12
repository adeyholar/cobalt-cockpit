#!/usr/bin/env bash
# Regenerates the README media from the plugin's own code: the capture, the animation and the artwork.
#   docs/assets/src/regenerate.sh
# The capture runs the committed plugin (a git archive of HEAD) in Claude Code's offline plugin test host with
# docs/assets/src/demo-capture.ts as its only test. No model is called and nothing is sent; the snapshot lives
# in a temporary directory that is removed at the end. Needs: claude, node, Google Chrome or Chromium, ffmpeg.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
snap=$(mktemp -d "${TMPDIR:-/tmp}/cockpit-capture-XXXXXX")
trap 'rm -rf -- "$snap"' EXIT
git -C "$root" archive --format=tar HEAD | tar -x -C "$snap"
find "$snap/tests" -name '*.test.ts' -delete
cp "$root/docs/assets/src/demo-capture.ts" "$snap/tests/demo-capture.test.ts"
(cd "$snap" && claude plugin test .) > "$snap/run.log" 2>&1 || { tail -20 "$snap/run.log" >&2; exit 1; }
# the commit that last changed what the capture runs: the plugin's code, its manifests and the test host file
node "$root/docs/assets/src/build-demo.mjs" "$snap/run.log" --sha "$(git -C "$root" log -1 --format=%H -- hooks agents types .claude-plugin tests/world.ts)"
node "$root/docs/assets/src/build-art.mjs" --png
