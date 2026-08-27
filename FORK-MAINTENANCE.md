# AspireOne T3 Code fork

This fork is kept close to `upstream/main`; keep local work in small,
focused branches. The tested snapshot is
`f6f2be32d8bc072e87753e41ad77c7c67e8b0b95`.

## Sync `main`

```sh
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

`origin` is the fork and `upstream` is `pingdotgg/t3code`. Never push to
`upstream`.

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

The normal output is `release/T3-Code-<version>-x64.exe`. For WSL support,
provide the Linux `node-pty` prebuild. When packaging from WSL, build the
Windows resource monitor with the MSVC Developer PowerShell and ensure Wine
is installed for Electron Builder's NSIS step:

```sh
cargo build --locked --release \
  --manifest-path native/resource-monitor/Cargo.toml \
  --target x86_64-pc-windows-msvc

T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true \
  vp run dist:desktop:win:x64 \
  --wsl-prebuild "$PWD/apps/server/node_modules/node-pty/build/Release/pty.node"
```

The artifact tested from this snapshot is
`release/T3-Code-0.0.35-x64.exe` (unsigned; updates are manual).

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

The packaged desktop app intentionally uses the normal T3 state locations.
Close the official app before switching builds and back up `%APPDATA%/t3code`
and `~/.t3`. Do not run official and forked packaged WSL backends together:
both currently use the distro's `~/.t3/userdata` database. Development runs
should use `./.t3` or another explicit isolated base dir.

This fork does not include the nested-workspace diff/checkpoint fix.
