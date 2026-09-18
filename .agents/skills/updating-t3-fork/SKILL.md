---
name: updating-t3-fork
description: Rebases this AspireOne T3 Code fork onto an official upstream release, resolves conflicts one fork commit at a time, validates, and optionally builds and installs the Windows artifact from WSL. Use when the user asks to update the fork, sync or rebase onto upstream, move to a new T3 Code release, or rebuild or install a new fork version. Not for ordinary feature work unless release synchronization is also requested.
---

# Updating the T3 fork

## Model

`main` is exactly one stable upstream release plus a small stack of fork
commits. A sync moves that stack onto a newer release:

- upstream release base = the release tag plus its post-tag
  `chore(release): prepare vX` version bump, nothing newer;
- the fork commits replay on top, one at a time, as a rebase.

The rebase is the point: when a conflict fires, it names the exact fork
commit whose code upstream touched, so each decision is local and explicit —
rework the fork commit onto the new upstream implementation, or drop it
because upstream now covers it.

## Before changing anything

1. Read repository `AGENTS.md`, `FORK_CONTEXT.md`, and `FORK-MAINTENANCE.md`.
2. Skim the release notes and `scripts/build-desktop-artifact.ts`; build
   behavior may have changed.
3. `origin` is the fork; `upstream` is `pingdotgg/t3code` with push disabled.
4. Require a clean worktree. Never stash or absorb unrelated user changes.

Command-level workflow: [references/manual-release-update.md](references/manual-release-update.md).

## Release selection

- Latest stable upstream release only. Never nightly or prerelease tags.
- Resolve the tag to its commit; it must be reachable from `upstream/main`.
- Upstream bumps package versions in the first post-tag
  `chore(release): prepare vX` commit. Rebase onto that commit, not the bare
  tag, or the fork reports the previous version and shows a stale update
  notice.
- If the selected release is already an ancestor of `main`, report that the
  fork is current and stop. Never roll `main` back.

## Integration workflow

1. Branch `sync/upstream-<tag>` from `main`.
2. Rebase the fork stack onto the release base. Drop the fork's own stale
   `chore(release): prepare` commit from the replay — the new base carries
   the new version.
3. Resolve conflicts per replayed commit:
   - prefer upstream for unrelated implementation churn;
   - keep the intent of focused fork commits, reworked for new surroundings;
   - if upstream now implements a fork change, drop that fork commit, and
     only after checking the released behavior actually covers it;
   - never resolve with blanket ours/theirs.
4. Run `vp i` when manifests or the lockfile changed.
5. Verify: the release base is an ancestor of the result, `git log` from the
   base is the expected fork stack (every dropped commit deliberately
   superseded), and manifests show the new version.
6. Run focused checks for conflicted areas plus the desktop production build.
   The Windows helper's build satisfies this during a full install; do not
   build the same revision twice. No repository-wide checks unless requested.
7. Publish only for a real sync, not for a trial, dry run, or build-only
   request: create `backup/pre-sync-<tag>` at the old `main`, update `main`
   to the validated sync branch, `git push --force-with-lease origin main`,
   delete the sync branch. Publishing rewrites fork SHAs, so force-push goes
   to `origin` only. Never push `upstream`.

The repo relies on global `rerere`: recurring conflicts resolve from recorded
solutions automatically, but re-check what a replayed solution actually did.

## Windows build and installation

Building does not imply permission to install. Install only when the user asks
for installation or an end-to-end update.

```sh
./build-install-windows.sh            # build, install, relaunch, verify
./build-install-windows.sh --build-only
```

The helper builds, gracefully closes the installed executable, waits for its
WSL backend, snapshots persistent state, installs, relaunches, and verifies
WSL health. It refuses dirty trees. Read `--help` before changing its
behavior; if release tooling, artifact names, or state locations changed
upstream, update the helper deliberately before running it. Toolchain
requirements and the current artifact pipeline shape are in the reference.

## Handoff

Report: selected tag and resolved commit; each conflicted or dropped fork
commit with its decision; checks and builds run; artifact path and SHA-256;
backup path when installation occurred; installed version and WSL backend
health; final branch, remotes, and `git status`.

Do not open a pull request unless explicitly asked.
