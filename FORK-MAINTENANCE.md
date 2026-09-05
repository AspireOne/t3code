# AspireOne T3 Code fork

This fork is kept close to official upstream releases; keep fork changes in
small, focused commits.

## Quick build / install

From the repository root in WSL:

```sh
# Build and validate without touching the installed app.
./build-install-windows.sh --build-only

# Build, back up state, install, relaunch, and verify WSL health.
./build-install-windows.sh

# Force a fresh JavaScript build and staged dependency installs.
./build-install-windows.sh --no-cache
```

## Sync `main`

For an official release update, use the repository's
[`updating-t3-fork`](./.agents/skills/updating-t3-fork/SKILL.md) skill.
It merges the exact stable release tag on a temporary integration branch and
validates the result before moving `main`, pushing `origin/main`, and deleting
the temporary branch. Those final steps are skipped only for an explicitly
local-only, dry-run, or build-only update.

`origin` is the fork and `upstream` is `pingdotgg/t3code`. Never push to
`upstream`; its push URL is intentionally disabled. Do not sync by merging
`upstream/main`: it may contain unreleased work. The skill selects and merges
the exact latest stable release tag.

## Install and run from source

Use the repository toolchain, not an ambient global version:

```sh
vp i
cp .env.example .env       # production public Connect identifiers
vp run dev                  # isolated development state: ./.t3
vp run dev:desktop          # Electron development shell
vp run build:desktop       # production web/server/desktop build
```

`vp` does not replace the normal Node or pnpm installation. It selects the
repo-pinned Node/pnpm versions for commands run through `vp`.

## Windows artifact

Use the tested helper from WSL. It installs repository dependencies, builds the
resource monitor with Windows MSVC, supplies the Linux `node-pty` prebuild for
WSL mode, and runs Electron Builder through Wine:

```sh
# Check prerequisites only.
./build-install-windows.sh --preflight
```

For the build and install commands, see [Quick build / install](#quick-build--install)
above.

The helper keeps verified build outputs and staged production dependency trees
in the repository's Git directory, keyed by tracked source, manifests,
toolchain metadata, and build environment. Cached trees are copied into each
temporary packaging directory before electron-builder runs, so packaging can
mutate its copy without weakening the next run. Windows Cargo intermediates
live under `%LOCALAPPDATA%/T3Code/build-cache`; Cargo still checks source,
lockfile, target, and compiler inputs on every invocation. Use `--no-cache` to
diagnose a clean JavaScript and staged-dependency rebuild. Each run prints
timings for the major build, package, backup, install, launch, and health-check
phases. The helper retains two recent cache entries per kind automatically.

State backups use `rsync --link-dest` against the last complete snapshot when
possible. Every snapshot remains a complete point-in-time tree, while
unchanged files consume no additional space. The `latest-windows-install`
link is published only after all requested state copies succeed.

The normal output is `release/T3-Code-<version>-x64.exe`. The helper prints the
source commit, artifact path, and SHA-256 for each build. Artifacts are unsigned
and installation remains manual. Current one-time prerequisites are Vite+,
Windows Rust/MSVC tooling, PowerShell, and working 64/32-bit Wine in WSL; the
helper does not install system packages.

## Connect and state

The root `.env` targets T3's production Clerk/relay deployment; it contains
public identifiers only. Use the fork-built CLI with an isolated base dir:

```sh
node apps/server/dist/bin.mjs connect login --base-dir "$PWD/.t3"
node apps/server/dist/bin.mjs connect link --base-dir "$PWD/.t3"
node apps/server/dist/bin.mjs connect status --base-dir "$PWD/.t3"
```

Production endpoints are `https://app.t3.codes` and
`https://relay.t3.codes`; do not add Clerk server secrets or deploy a relay.

The packaged desktop app intentionally uses the normal T3 identity and state
locations. The install helper closes that exact per-user installation and backs
up `~/.t3` plus `%APPDATA%/t3code` and `%APPDATA%/T3 Code (Alpha)` when present.
Packaged WSL runtimes are keyed by their archive SHA-256, so fork builds that
retain the upstream semantic version still receive a fresh runtime cache. Do
not run official and forked packaged WSL backends together: both currently use
the distro's `~/.t3/userdata` database. Development runs should use `./.t3` or
another explicit isolated base dir.
