#!/usr/bin/env bash
# Two genuine Claude Code processes against one disposable plugin store (v0.6.0). Engineering evidence only: it shows that two
# real host processes started in one project read the same alert history, migrate it without losing an occurrence, refuse the
# person-only export and deletion to their non-person origin, and agree on the cleanup plan, with the host's own store locking
# in between. It does not show that a person saw
# anything, and it cannot acknowledge an alert: `claude -p` runs with the `sdk` origin, which Cockpit refuses for
# acknowledgments on purpose, and the harness does not weaken that.
#
#   scripts/acceptance-harness.sh [--keep]
#
# Isolation: everything lives under a new private directory made by mktemp (${TMPDIR:-/tmp}/cobalt-harness-*): its own
# CLAUDE_CONFIG_DIR (so its own plugin store, sessions and projects), its own XDG_STATE_HOME, a snapshot of the committed tree
# as the plugin, and an empty project directory. The operator's configuration, store and session history are never read or
# written; the script refuses to run if any path it would use is outside that directory. No credential is copied, no model is
# called (only immediate /cockpit commands run), and nothing is installed. Cleanup removes that directory and nothing else.
set -euo pipefail
umask 077
keep=0
[[ ${1:-} == --keep ]] && keep=1
fail() { printf 'harness: %s\n' "$*" >&2; exit 2; }
repo=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run it inside the plugin repository'
claude_bin=${CLAUDE_BIN:-$(command -v claude || true)}
[[ -n $claude_bin && -x $claude_bin ]] || fail 'claude was not found on PATH (set CLAUDE_BIN)'
root=$(mktemp -d "${TMPDIR:-/tmp}/cobalt-harness-XXXXXX")
root=$(realpath -e -- "$root")
[[ $root == */cobalt-harness-* ]] || fail "unexpected harness directory: $root"
cleanup() { if [[ $keep -eq 0 && -n ${root:-} && $root == */cobalt-harness-* && -d $root ]]; then rm -rf -- "$root"; fi; }
trap cleanup EXIT
config=$root/config; state=$root/state; plugin=$root/plugin; project=$root/project; home=$root/home
mkdir -p "$config" "$state" "$plugin" "$project" "$home"
for p in "$config" "$state" "$plugin" "$project" "$home"; do case "$p/" in "$root"/*) ;; *) fail "path outside the harness directory: $p" ;; esac; done
git -C "$repo" archive --format=tar HEAD | tar -x -C "$plugin"
settings='{"pluginConfigs":{"cobalt-cockpit@inline":{"options":{"guardRecordOnly":true,"telemetry":false}}}}'
run() { # one genuine host process: an immediate /cockpit command in the project, isolated configuration, no model
  # a home of its own, and no authentication variable from the operator's environment
  (cd "$project" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u CLAUDE_CODE_OAUTH_TOKEN \
    -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY -u CLAUDE_CODE_USE_MANTLE \
    HOME=$home CLAUDE_CONFIG_DIR=$config XDG_STATE_HOME=$state DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    timeout 90 "$claude_bin" -p "$1" --plugin-dir "$plugin" --settings "$settings" < /dev/null)
}
pass=0; failed=0
check() { if eval "$2"; then printf '  PASS %s\n' "$1"; pass=$((pass + 1)); else printf '  FAIL %s\n' "$1"; failed=$((failed + 1)); fi; }

printf 'harness: %s (cobalt-cockpit %s)\n' "$root" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json" | head -1)"
# 1. a first process creates the store; its name is the host's, so it is found rather than guessed
run '/cockpit version' > "$root/warmup.txt" 2>&1 || fail 'the warm-up process failed (see --keep)'
store=$(find "$config/plugins/store" -maxdepth 1 -name 'cobalt-cockpit_*.json' -print -quit)
[[ -n $store ]] || fail 'the host created no plugin store'
# 2. seed it, while no process runs, with a v0.5.7 history of this project and of another, through the same JSON the host keeps
python3 - "$store" "$project" <<'PY'
import hashlib, json, sys
store, project = sys.argv[1], sys.argv[2]
def fnv(text):
    h = 0x811c9dc5
    for ch in text:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xffffffff
    return f'{h:08x}'
mine = hashlib.sha256(f'cobalt-cockpit/alerts/v1\0{project}'.encode()).hexdigest()[:12]
other = 'f' * 12
def rec(key, kind, task, at):
    return {'key': key, 'kind': kind, 'taskId': task, 'at': at, 'outcome': 'recorded', 'attempts': 0, 'channel': None, 'id': fnv(f'{key}\0{at}\0{0}')}
data = json.load(open(store))
data['alert-history'] = {'v': 1, 'projects': {
    mine: [rec('1@1:security-failure:SECURITY', 'security-failure', 1, 1000), rec('2@2:run-blocked:task', 'run-blocked', 2, 2000)],
    other: [rec('9@9:run-blocked:task', 'run-blocked', 9, 3000)],
}}
json.dump(data, open(store, 'w'), indent=2)
print(mine)
PY
# 3. two processes at once: each starts a session, takes up the history and writes the occurrences to keys of their own
run '/cockpit alerts export' > "$root/a.json" 2> "$root/a.err" & a=$!
run '/cockpit alerts export' > "$root/b.json" 2> "$root/b.err" & b=$!
wait $a; ea=$?; wait $b; eb=$?
check 'both processes exited 0' "[[ $ea -eq 0 && $eb -eq 0 ]]"
# an export is refused for the sdk origin (it is the person's alone), so each run prints the refusal: that is the expected answer
check 'the export is refused to a non-person origin in both' "grep -q 'only for a command you type' '$root/a.json' && grep -q 'only for a command you type' '$root/b.json'"
run '/cockpit alerts' > "$root/c.txt" 2>&1 & c=$!
run '/cockpit alerts' > "$root/d.txt" 2>&1 & d=$!
wait $c; wait $d
check 'both list the same two occurrences of this project' "[[ \$(grep -cE '^  [0-9a-f]{8} ' '$root/c.txt') -eq 2 && \$(grep -cE '^  [0-9a-f]{8} ' '$root/d.txt') -eq 2 ]] && diff <(grep -oE '^  [0-9a-f]{8} [A-Z]+ [a-z-]+' '$root/c.txt' | sort) <(grep -oE '^  [0-9a-f]{8} [A-Z]+ [a-z-]+' '$root/d.txt' | sort) >/dev/null"
check 'neither lists the other project' "! grep -q '9@9\|task 9 ' '$root/c.txt' '$root/d.txt'"
check 'a non-person look writes no look marker' "! grep -q '\"alert-seen:' '$store'"
python3 - "$store" > "$root/keys.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('\n'.join(sorted(k for k in d if k.startswith('alert-') or k.startswith('ledger:'))))
PY
check 'two genuine sessions persisted their own ledgers' "[[ \$(grep -c '^ledger:' '$root/keys.txt') -ge 2 ]]"
check 'both occurrences of this project have keys of their own, none lost to the concurrent writes' "[[ \$(grep -c '^alert-occ:' '$root/keys.txt') -eq 2 ]]"
check 'the v0.5.7 key is kept: another project in it was never migrated' "grep -qx 'alert-history' '$root/keys.txt'"
run '/cockpit alerts legacy' > "$root/e.txt" 2>&1 & e=$!
run '/cockpit alerts legacy' > "$root/f.txt" 2>&1 & f=$!
wait $e; wait $f
check 'both dry runs agree and delete nothing' "grep -q 'DRY RUN' '$root/e.txt' && diff '$root/e.txt' '$root/f.txt' >/dev/null && grep -qx 'alert-history' <(python3 -c 'import json,sys; print(chr(10).join(json.load(open(sys.argv[1]))))' '$store')"
check 'a deletion from a non-person origin is refused' "run \"/cockpit alerts legacy delete \$(grep -oE 'delete [0-9a-f]{8}' '$root/e.txt' | cut -d' ' -f2 || echo 00000000)\" 2>&1 | grep -qE 'only by a command you type|nothing can be deleted|Nothing was|does not match'"
printf 'harness: %d passed, %d failed. Engineering evidence only: no person observed anything, and nothing was acknowledged.\n' "$pass" "$failed"
[[ $keep -eq 1 ]] && printf 'harness: kept %s\n' "$root"
[[ $failed -eq 0 ]]
