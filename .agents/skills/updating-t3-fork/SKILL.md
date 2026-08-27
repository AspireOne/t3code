---
name: updating-t3-fork
description: Synchronizes this AspireOne T3 Code fork to an official upstream release, resolves and validates merge conflicts, and builds or installs the Windows desktop artifact with WSL support. Use when the user asks to update the fork, sync with the latest T3 Code release, merge an upstream release, rebuild the fork, or install a new fork version. Do not use for ordinary feature work, unreleased upstream-main snapshots, or pipeline design unless release synchronization is also requested.
---

# Updating the T3 fork

## Goal

Bring the fork forward to an exact official upstream release without losing its
small local changes, then optionally build and install a verified Windows/WSL
desktop update. Keep the operation reproducible and leave a clear record of the
release tag and commit used.

## Before changing anything

1. Read the repository `AGENTS.md`, `FORK_CONTEXT.md`, and
   `FORK-MAINTENANCE.md`.
2. Inspect the current upstream README, contribution guide, package manifests,
   release notes, and `scripts/build-desktop-artifact.ts`. Upstream build or
   release behavior may have changed since this skill was written.
3. Confirm `origin` is the AspireOne fork and `upstream` fetches
   `https://github.com/pingdotgg/t3code.git`. Keep upstream push disabled.
4. Require a clean worktree. Do not stash, discard, or absorb unrelated user
   changes merely to make the update proceed.

Read [references/manual-release-update.md](references/manual-release-update.md)
for the command-level workflow.

## Release selection

- Default to GitHub's latest non-draft, non-prerelease upstream release. Do not
  treat nightly or desktop-preview releases as stable.
- Use a nightly only when the user explicitly requests the nightly channel.
- Fetch upstream and tags, then resolve the release tag to its commit. Merge
  that tag, not `upstream/main`, so the fork contains exactly the intended
  released upstream history rather than later unreleased commits.
- If the release commit is already an ancestor of the fork, report that the
  fork is already at or ahead of that release. Never roll a newer fork back to
  the latest stable release automatically.

## Integration workflow

Use the temporary sync branch as a safety boundary: `main` stays known-good
while conflicts, builds, and verification are in progress. The branch does not
add history of its own and is deleted after the validated result is
fast-forwarded to `main`.

1. Create a branch named `sync/upstream-<tag>` from the fork's current `main`.
2. Merge the release tag. Preserve history; do not reset or force-push `main`.
3. Resolve conflicts by understanding both changes:
   - Prefer upstream for unrelated implementation churn.
   - Preserve the intent of focused fork commits when upstream has not replaced
     them.
   - When upstream contains an equivalent local fix, remove the redundant fork
     change only after verifying the released behavior.
   - Never choose `ours` or `theirs` across a broad path without inspecting the
     resulting code.
4. Re-run `vp i` when manifests or the lockfile changed.
5. Verify the release commit is an ancestor of the result and inspect the
   remaining fork-only commits.
6. Run the smallest relevant checks plus the desktop production build. The
   Windows artifact helper's build satisfies this step during a full install;
   do not build the same revision twice without a reason. Do not run
   repository-wide checks unless the user requests them.
7. Fast-forward local `main` to the validated sync branch, push `origin/main`,
   and delete the local sync branch. This completes the normal release-sync
   workflow. Skip updating `main` or pushing only when the user explicitly asks
   for a local-only trial, dry run, or build-only operation. Never push
   upstream or force-push.

Do not open a pull request unless explicitly requested.

## Windows build and installation

Building does not imply permission to install. Install only when the user asks
for installation or an end-to-end update.

For the current WSL-to-Windows packaging path, use:

```sh
.agents/skills/updating-t3-fork/scripts/build-install-windows.sh
```

The helper builds first, then gracefully closes the exact installed T3
executable, waits for its WSL backend to stop, snapshots persistent state,
installs the new NSIS artifact, relaunches it, and verifies local WSL health.
It refuses dirty trees and does not force-kill the app. Use `--build-only` when
installation was not requested, and read `--help` before changing its behavior.

Treat the helper as an implementation of the current workflow, not permanent
upstream truth. If release tooling, native dependencies, artifact names, app
identity, or state locations changed, update the helper deliberately before
running it.

## Verification and handoff

Confirm and report:

- selected release tag and resolved upstream commit;
- merge/conflict decisions and remaining fork-only commits;
- checks and builds run;
- artifact path and SHA-256;
- backup path when installation occurred;
- installed executable, launched version, and WSL backend health;
- production T3 Connect status when relevant to the release or requested;
- final branch, remotes, and `git status`.

Keep the nested-workspace project structure intact. Updating the fork does not
authorize unrelated fixes, a self-hosted Connect deployment, or changes to the
user's project layout.
