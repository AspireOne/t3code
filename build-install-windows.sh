#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Build and optionally install this fork's Windows x64 desktop artifact from WSL.

Usage:
  build-install-windows.sh [--preflight | --build-only] [--no-backup] [--no-launch] [--no-verify] [--verbose]

Default behavior:
  1. Require a clean Git worktree and current build prerequisites.
  2. Build the Windows resource monitor and packaged desktop installer.
  3. Gracefully close the exact standard T3 installation.
  4. Back up Windows and WSL T3 state outside the repository.
  5. Silently install, relaunch, and verify the WSL backend health endpoint.

Options:
  --preflight    Check prerequisites and repository state only.
  --build-only   Build and validate the artifact without touching the installation.
  --no-backup    Skip the pre-install state backup.
  --no-launch    Install but do not relaunch T3 Code.
  --no-verify    Relaunch without waiting for the WSL health endpoint.
  --verbose      Stream verbose desktop artifact build output.
  --help         Show this help.

This helper never force-kills T3 Code and never installs system packages.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

mode="install"
backup_enabled=true
launch_enabled=true
verify_enabled=true
verbose_enabled=false

while (($# > 0)); do
  case "$1" in
    --preflight) mode="preflight" ;;
    --build-only) mode="build" ;;
    --no-backup) backup_enabled=false ;;
    --no-launch) launch_enabled=false ;;
    --no-verify) verify_enabled=false ;;
    --verbose) verbose_enabled=true ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel)
git_dir=$(git -C "$repo_root" rev-parse --git-dir)
[[ "$git_dir" = /* ]] || git_dir="$repo_root/$git_dir"
linux_home=$(getent passwd "$(id -u)" | cut -d: -f6)
support_dir="$repo_root/.agents/skills/updating-t3-fork/scripts"

[[ -n "${WSL_DISTRO_NAME:-}" ]] || fail "run this helper from WSL"

for command in git vp jq curl rsync wslpath pwsh.exe sha256sum flock; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is missing: $command"
done

if ! command -v wine >/dev/null 2>&1 && ! command -v wine64 >/dev/null 2>&1; then
  fail "Wine is required in WSL for Electron Builder's Windows packaging step"
fi

exec 9>"$git_dir/t3-fork-windows-update.lock"
flock -n 9 || fail "another fork build/install helper is already running"

cd "$repo_root"
dirty=$(git status --porcelain --untracked-files=normal)
[[ -z "$dirty" ]] || fail "the Git worktree must be clean before producing an installable artifact"

[[ "$(git config --get remote.upstream.url || true)" = "https://github.com/pingdotgg/t3code.git" ]] ||
  fail "remote 'upstream' is not https://github.com/pingdotgg/t3code.git"

repo_root_windows=$(wslpath -w "$repo_root")
resource_script_windows=$(wslpath -w "$support_dir/build-resource-monitor-windows.ps1")
manager_script_windows=$(wslpath -w "$support_dir/manage-windows-t3.ps1")

printf 'Repository: %s\n' "$repo_root"
printf 'Commit: %s\n' "$(git rev-parse HEAD)"

if [[ "$mode" = "preflight" ]]; then
  printf 'Preflight passed.\n'
  exit 0
fi

vp i

post_install_dirty=$(git status --porcelain --untracked-files=normal)
[[ -z "$post_install_dirty" ]] ||
  fail "vp i changed tracked or untracked repository files; review and commit them before building"

pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$resource_script_windows" \
  -RepoRoot "$repo_root_windows" \
  -Arch x64

wsl_prebuild="$repo_root/apps/server/node_modules/node-pty/build/Release/pty.node"
[[ -f "$wsl_prebuild" ]] || fail "Linux node-pty prebuild is missing at $wsl_prebuild"

build_args=(run dist:desktop:win:x64 --wsl-prebuild "$wsl_prebuild")
if [[ "$verbose_enabled" = true ]]; then
  build_args+=(--verbose)
fi
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true vp "${build_args[@]}"

version=$(jq -er '.version | select(type == "string" and length > 0)' apps/desktop/package.json)
artifact="$repo_root/release/T3-Code-$version-x64.exe"
[[ -f "$artifact" ]] || fail "expected installer was not produced at $artifact"
artifact_hash=$(sha256sum "$artifact" | awk '{print $1}')

printf 'Artifact: %s\n' "$artifact"
printf 'SHA-256: %s\n' "$artifact_hash"

if [[ "$mode" = "build" ]]; then
  exit 0
fi

runtime_state="$linux_home/.t3/userdata/server-runtime.json"
runtime_pid=""
if [[ -f "$runtime_state" ]]; then
  runtime_pid=$(jq -r '.pid // empty' "$runtime_state" 2>/dev/null || true)
fi

pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$manager_script_windows" \
  -Action Stop

if [[ -n "$runtime_pid" ]]; then
  for _ in $(seq 1 30); do
    [[ ! -d "/proc/$runtime_pid" ]] && break
    sleep 1
  done
  [[ ! -d "/proc/$runtime_pid" ]] ||
    fail "the previous WSL backend process $runtime_pid did not stop; it was not force-killed"
fi

backup_dir=""
if [[ "$backup_enabled" = true ]]; then
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_parent="$(dirname "$repo_root")/t3code-backups"
  backup_dir="$backup_parent/before-$version-$timestamp-$(git rev-parse --short=12 HEAD)"
  mkdir -p -- "$backup_parent"
  mkdir -m 700 -- "$backup_dir"

  if [[ -d "$linux_home/.t3" ]]; then
    mkdir -m 700 -- "$backup_dir/wsl-t3"
    rsync -a -- "$linux_home/.t3/" "$backup_dir/wsl-t3/"
  fi

  windows_app_data=$(pwsh.exe -NoProfile -Command '[Environment]::GetFolderPath("ApplicationData")' | tr -d '\r')
  windows_app_data_wsl=$(wslpath -u "$windows_app_data")
  for state_name in t3code 'T3 Code (Alpha)'; do
    state_path="$windows_app_data_wsl/$state_name"
    if [[ -d "$state_path" ]]; then
      backup_name="windows-roaming-${state_name// /-}"
      mkdir -m 700 -- "$backup_dir/$backup_name"
      rsync -a -- "$state_path/" "$backup_dir/$backup_name/"
    fi
  done

  chmod -R go-rwx -- "$backup_dir"
  printf 'Backup: %s\n' "$backup_dir"
fi

# Fork builds can retain the upstream semantic version while changing the
# bundled server. The desktop WSL extractor keys its generated tree by that
# version, so invalidate the exact cache after the old backend has stopped.
windows_user_profile=$(pwsh.exe -NoProfile -Command '[Environment]::GetFolderPath("UserProfile")' | tr -d '\r')
windows_user_profile_wsl=$(wslpath -u "$windows_user_profile")
wsl_server_tree_cache="$windows_user_profile_wsl/.t3/userdata/wsl-server-tree/$version"
if [[ -d "$wsl_server_tree_cache" ]]; then
  rm -rf -- "$wsl_server_tree_cache"
  printf 'Invalidated WSL server cache: %s\n' "$wsl_server_tree_cache"
fi

artifact_windows=$(wslpath -w "$artifact")
pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$manager_script_windows" \
  -Action Install \
  -InstallerPath "$artifact_windows"

if [[ "$launch_enabled" = false ]]; then
  printf 'Installation completed; launch was skipped.\n'
  exit 0
fi

printf 'Waiting for Windows to finish installer cleanup...\n'
sleep 2
launch_started_epoch=$(date -u +%s)
pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$manager_script_windows" \
  -Action Launch

sleep 2
launch_status=$(pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$manager_script_windows" \
  -Action Status)
launch_process_count=$(jq -r '.processes | length' <<<"$launch_status")
if [[ "$launch_process_count" -eq 0 ]]; then
  # NSIS cleanup can briefly outlive the installer process. Retry the normal
  # launcher once instead of treating that transient first exit as a crash.
  printf 'Initial launch exited during installer cleanup; retrying...\n'
  sleep 5
  pwsh.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$manager_script_windows" \
    -Action Launch
  sleep 2
  launch_status=$(pwsh.exe -NoProfile -ExecutionPolicy Bypass \
    -File "$manager_script_windows" \
    -Action Status)
  launch_process_count=$(jq -r '.processes | length' <<<"$launch_status")
fi
[[ "$launch_process_count" -gt 0 ]] || fail "T3 Code exited after two launch attempts"

if [[ "$verify_enabled" = false ]]; then
  printf 'Installation and launch completed; health verification was skipped.\n'
  exit 0
fi

health_payload=""
for _ in $(seq 1 90); do
  if [[ -f "$runtime_state" ]]; then
    candidate_pid=$(jq -r '.pid // empty' "$runtime_state" 2>/dev/null || true)
    origin=$(jq -r '.origin // empty' "$runtime_state" 2>/dev/null || true)
    started_at=$(jq -r '.startedAt // empty' "$runtime_state" 2>/dev/null || true)
    started_epoch=$(date -d "$started_at" +%s 2>/dev/null || printf '0')
    if [[ -n "$candidate_pid" && -d "/proc/$candidate_pid" && -n "$origin" &&
      "$started_epoch" -ge "$launch_started_epoch" ]]; then
      health_payload=$(curl -fsS --max-time 2 "$origin/.well-known/t3/environment" 2>/dev/null || true)
      if [[ -n "$health_payload" ]]; then
        break
      fi
    fi
  fi
  sleep 1
done

[[ -n "$health_payload" ]] || fail "the installed app launched, but its WSL health endpoint was not ready within 90 seconds"
health_version=$(jq -r '.serverVersion // empty' <<<"$health_payload")
health_os=$(jq -r '.platform.os // empty' <<<"$health_payload")
[[ "$health_version" = "$version" ]] ||
  fail "health endpoint reported version '$health_version'; expected '$version'"
[[ "$health_os" = "linux" ]] ||
  fail "health endpoint reported platform '$health_os'; expected the WSL Linux backend"

pwsh.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$manager_script_windows" \
  -Action Status
printf 'Installed fork %s is running with a healthy WSL backend.\n' "$version"
