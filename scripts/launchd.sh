#!/usr/bin/env bash
# Manage Pursuit as two macOS LaunchAgents that start at login and restart on crash:
#   com.kayzee.pursuit.worker     the engine (discovery, scoring, tailoring, applying, inbox)
#   com.kayzee.pursuit.dashboard  the production dashboard on http://localhost:7020 (run `next build` first)
#   com.kayzee.pursuit.awake      caffeinate -s -i: no idle sleep while on mains power (uninstall to undo)
# Both call the project's own binaries (no pnpm), so a stray ~/package.json can't interfere.
#
#   scripts/launchd.sh install     write ~/Library/LaunchAgents/com.kayzee.pursuit.worker.plist and load it
#   scripts/launchd.sh uninstall   unload it and delete the plist
#   scripts/launchd.sh status      show whether it is installed/loaded and the last log lines
#   scripts/launchd.sh print       print the plist that install would write (changes nothing)
#
# Logs: data/logs/{worker,dashboard}.{out,err}.log in the repo.
# Nothing here runs automatically; Kayzee decides when to install.

set -euo pipefail

SERVICES=(worker dashboard awake)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_DIR}/data/logs"
DOMAIN="gui/$(id -u)"

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

# Drops repeated entries from a colon-separated PATH, keeping the first occurrence's position.
dedupe_path() {
  local out="" dir
  local IFS=':'
  for dir in $1; do
    [[ -z "${dir}" ]] && continue
    case ":${out}:" in
      *":${dir}:"*) ;;
      *) out="${out:+${out}:}${dir}" ;;
    esac
  done
  printf '%s' "${out}"
}

resolve_pnpm() {
  local pnpm_bin
  pnpm_bin="$(command -v pnpm || true)"
  if [[ -z "${pnpm_bin}" ]]; then
    echo "error: pnpm not found on PATH. Install it or run this from a shell where 'pnpm' works." >&2
    exit 1
  fi
  printf '%s' "${pnpm_bin}"
}

label_for() { printf 'com.kayzee.pursuit.%s' "$1"; }
plist_for() { printf '%s/Library/LaunchAgents/%s.plist' "${HOME}" "$(label_for "$1")"; }

# Program arguments for each service, one per line.
args_for() {
  case "$1" in
    worker) printf '%s\n' "${REPO_DIR}/node_modules/.bin/tsx" "src/worker/index.ts" ;;
    dashboard) printf '%s\n' "${REPO_DIR}/node_modules/.bin/next" "start" "-p" "7020" ;;
    # Keeps the Mac from idle-sleeping while it is on mains power, so the worker can run overnight.
    # A process, not a settings change: unloading this service restores normal sleep. Closing the lid still sleeps.
    awake) printf '%s\n' "/usr/bin/caffeinate" "-s" "-i" ;;
  esac
}

render_plist() {
  local svc="$1" LABEL pnpm_bin node_dir path_value args="" a
  LABEL="$(label_for "${svc}")"
  while IFS= read -r a; do args="${args}    <string>$(xml_escape "${a}")</string>
"; done < <(args_for "${svc}")
  pnpm_bin="$(resolve_pnpm)"
  # launchd starts with a minimal PATH; include node's and pnpm's directories so `tsx` and
  # `tectonic` (Homebrew) resolve the same way they do in an interactive shell.
  node_dir="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
  path_value="$(dedupe_path "$(dirname "${pnpm_bin}"):${node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${REPO_DIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "${path_value}")</string>
    <key>HOME</key>
    <string>$(xml_escape "${HOME}")</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>NEXT_TELEMETRY_DISABLED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>120</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${LOG_DIR}/${svc}.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${LOG_DIR}/${svc}.err.log")</string>
</dict>
</plist>
PLIST
}

is_loaded() { launchctl print "${DOMAIN}/$(label_for "$1")" >/dev/null 2>&1; }

install_one() {
  local svc="$1" label plist tmp
  label="$(label_for "${svc}")"; plist="$(plist_for "${svc}")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/pursuit-plist.XXXXXX")"
  render_plist "${svc}" >"${tmp}"
  if ! plutil -lint "${tmp}" >/dev/null; then
    echo "error: generated plist for ${svc} failed validation:" >&2; plutil -lint "${tmp}" >&2 || true; rm -f "${tmp}"; exit 1
  fi
  if is_loaded "${svc}"; then launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true; sleep 1; fi
  mv "${tmp}" "${plist}"; chmod 644 "${plist}"
  launchctl bootstrap "${DOMAIN}" "${plist}"
  launchctl enable "${DOMAIN}/${label}" 2>/dev/null || true
  echo "Installed and started ${label} (logs: ${LOG_DIR}/${svc}.{out,err}.log)"
}

cmd_install() {
  mkdir -p "${LOG_DIR}" "${HOME}/Library/LaunchAgents"
  [[ -x "${REPO_DIR}/node_modules/.bin/tsx" && -x "${REPO_DIR}/node_modules/.bin/next" ]] || { echo "error: run pnpm install in ${REPO_DIR} first" >&2; exit 1; }
  [[ -f "${REPO_DIR}/.next/BUILD_ID" ]] || { echo "error: build the dashboard first: node_modules/.bin/next build" >&2; exit 1; }
  for svc in "${SERVICES[@]}"; do install_one "${svc}"; done
}

cmd_uninstall() {
  for svc in "${SERVICES[@]}"; do
    local label plist; label="$(label_for "${svc}")"; plist="$(plist_for "${svc}")"
    if is_loaded "${svc}"; then launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true; echo "Stopped ${label}"; fi
    if [[ -f "${plist}" ]]; then rm -f "${plist}"; echo "Removed ${plist}"; fi
  done
}

cmd_status() {
  for svc in "${SERVICES[@]}"; do
    local label pid; label="$(label_for "${svc}")"
    if is_loaded "${svc}"; then
      pid="$(launchctl print "${DOMAIN}/${label}" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')"
      echo "${svc}: running${pid:+ (pid ${pid})}"
    else
      echo "${svc}: not running"
    fi
    [[ -f "${LOG_DIR}/${svc}.err.log" ]] && { echo "  --- ${svc}.err.log (last 3)"; tail -n 3 "${LOG_DIR}/${svc}.err.log"; }
  done
}

case "${1:-}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  print) for svc in "${SERVICES[@]}"; do render_plist "${svc}"; done ;;
  *)
    echo "Usage: $0 install|uninstall|status|print" >&2
    exit 2
    ;;
esac
