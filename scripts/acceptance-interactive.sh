#!/usr/bin/env bash
# A disposable place to try the committed candidate by hand, in two real Claude Code sessions on one test project (v0.6.2).
# Engineering preparation only: it starts nothing on its own, simulates no acknowledgment and confirms nothing for you.
#
#   scripts/acceptance-interactive.sh setup  [--dir <new empty directory>]   build it and print the two launch commands
#   scripts/acceptance-interactive.sh verify <dir>                           probe it with the host (no model, no login needed)
#   scripts/acceptance-interactive.sh launch <dir> 1|2                       start session 1 or 2 (a terminal each)
#   scripts/acceptance-interactive.sh clean  <dir>                           remove it
#
# Isolation: everything lives under one new private directory. It has its own CLAUDE_CONFIG_DIR and HOME, so the installed
# user-scope plugin, your settings, your sessions and your store are neither read nor written, and the candidate is the only
# Cockpit that loads (no duplicate registration). The plugin is a snapshot of the committed tree (`git archive HEAD`), loaded
# with `--plugin-dir`; commit or discard changes first, the script refuses a dirty tree. No credential is copied: you sign in once,
# inside the disposable configuration, on the first launch (both sessions share it). Set COBALT_ACCEPT_PASS_AUTH=1 to pass
# ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from your environment instead. The plugin options (alerts on, a short reminder
# interval) are given with --settings for these launches only.
set -euo pipefail
umask 077
fail() { printf 'acceptance-interactive: %s\n' "$*" >&2; exit 2; }
cmd=${1:-}; shift || true
claude_bin=${CLAUDE_BIN:-$(command -v claude || true)}
[[ -n $claude_bin && -x $claude_bin ]] || fail 'claude was not found on PATH (set CLAUDE_BIN)'
settings='{"pluginConfigs":{"cobalt-cockpit@inline":{"options":{"guardAlerts":true,"guardRepeat":true,"guardRepeatSec":60,"guardCooldownSec":30,"guardMaxReminders":3,"guardDigest":false,"telemetry":false}}}}'

check_dir() { # the directory must be one this script made
  local d=${1:-}
  [[ -n $d && -d $d ]] || fail "not a directory: ${d:-<none>}"
  d=$(realpath -e -- "$d")
  [[ $d == */cobalt-accept-* && -f $d/.made-by-acceptance-interactive ]] || fail "not a directory made by this script: $d"
  printf '%s' "$d"
}
host_env() { # the disposable environment, and only the terminal facts a notification channel is chosen from
  local d=$1
  local -a e=(PATH="$PATH" TERM="${TERM:-xterm-256color}" LANG="${LANG:-C.UTF-8}" HOME="$d/home" CLAUDE_CONFIG_DIR="$d/config" XDG_STATE_HOME="$d/state" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1)
  for v in COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION KITTY_WINDOW_ID ITERM_SESSION_ID GHOSTTY_RESOURCES_DIR LC_ALL; do [[ -n ${!v:-} ]] && e+=("$v=${!v}"); done
  if [[ ${COBALT_ACCEPT_PASS_AUTH:-0} == 1 ]]; then for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do [[ -n ${!v:-} ]] && e+=("$v=${!v}"); done; fi
  printf '%s\0' "${e[@]}"
}
in_host() { # in_host <dir> <command...>: run with the disposable environment, in the project directory
  local d=$1; shift
  local -a e=(); while IFS= read -r -d '' x; do e+=("$x"); done < <(host_env "$d")
  (cd "$d/project" && env -i "${e[@]}" "$@")
}

case $cmd in
  setup)
    dir=
    [[ ${1:-} == --dir ]] && dir=${2:-}
    repo=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'run it inside the plugin repository'
    [[ -z $(git -C "$repo" status --porcelain) ]] || fail 'the working tree is not clean: commit or discard first, so the candidate is exactly a commit'
    sha=$(git -C "$repo" rev-parse HEAD)
    if [[ -z $dir ]]; then dir=$(mktemp -d "${TMPDIR:-/tmp}/cobalt-accept-XXXXXX"); else [[ ! -e $dir || -z $(ls -A -- "$dir") ]] || fail "not empty: $dir"; mkdir -p -- "$dir"; fi
    dir=$(realpath -e -- "$dir")
    [[ $dir == */cobalt-accept-* ]] || fail "the directory name must contain cobalt-accept-: $dir"
    mkdir -p "$dir/config" "$dir/state" "$dir/home" "$dir/plugin" "$dir/project"
    : > "$dir/.made-by-acceptance-interactive"
    git -C "$repo" archive --format=tar HEAD | tar -x -C "$dir/plugin"
    printf '%s\n' "$sha" > "$dir/candidate-sha"
    ( cd "$dir/project" && git init -q . && printf '# disposable acceptance project\n' > README.md && git add README.md && git -c user.name=acceptance -c user.email=acceptance@example.invalid commit -q -m 'disposable project' )
    printf 'candidate %s (cobalt-cockpit %s)\ndirectory %s\n\n' "$sha" "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/plugin/.claude-plugin/plugin.json" | head -1)" "$dir"
    printf 'Next:\n  %s verify %s\n  %s launch %s 1     # terminal 1\n  %s launch %s 2     # terminal 2, after session 1 has recorded and acknowledged\n  %s clean %s\n' "$0" "$dir" "$0" "$dir" "$0" "$dir" "$0" "$dir"
    ;;
  verify)
    dir=$(check_dir "${1:-}")
    echo "candidate: $(cat "$dir/candidate-sha")"
    echo '--- installed plugins in the disposable configuration (expect none):'
    in_host "$dir" "$claude_bin" plugin list 2>&1 | head -5
    echo '--- what is loaded, from where:'
    in_host "$dir" timeout 90 "$claude_bin" -p '/cockpit version' --plugin-dir "$dir/plugin" --settings "$settings" < /dev/null 2>&1 | head -12
    echo '--- strict validation of the snapshot:'
    in_host "$dir" "$claude_bin" plugin validate --strict "$dir/plugin" 2>&1 | tail -2
    ;;
  launch)
    dir=$(check_dir "${1:-}"); n=${2:-}
    [[ $n == 1 || $n == 2 ]] || fail 'launch <dir> 1|2'
    local_args=(--plugin-dir "$dir/plugin" --settings "$settings")
    printf 'Session %s of the candidate %s in %s/project\nExit with /exit or Ctrl+C twice. To continue session 1 after a restart, launch it again with CONTINUE=1.\n' "$n" "$(cat "$dir/candidate-sha")" "$dir"
    [[ $n == 1 && ${CONTINUE:-0} == 1 ]] && local_args+=(--continue)
    in_host "$dir" "$claude_bin" "${local_args[@]}"
    ;;
  clean)
    dir=$(check_dir "${1:-}")
    rm -rf -- "$dir"
    echo "removed $dir"
    ;;
  *) fail 'usage: acceptance-interactive.sh setup [--dir D] | verify D | launch D 1|2 | clean D' ;;
esac
