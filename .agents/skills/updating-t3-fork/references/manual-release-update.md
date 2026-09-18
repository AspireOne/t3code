# Manual release update

Command-level workflow for the rebase sync. Re-check upstream tooling and
scripts when release behavior changes.

## Resolve the upstream release

```sh
gh_command=gh; command -v gh >/dev/null 2>&1 || gh_command=gh.exe
"$gh_command" api repos/pingdotgg/t3code/releases/latest \
  --jq '{tag: .tag_name, commit: .target_commitish, published: .published_at}'
```

`releases/latest` selects the latest stable release. Fetch and verify:

```sh
git fetch upstream main --tags --prune
release_tag=v0.0.XX
release_commit=$(git rev-parse "$release_tag^{commit}")
git merge-base --is-ancestor "$release_commit" upstream/main
```

Stop if the tag is missing, unreachable, or does not match the selected
GitHub release.

## Find the rebase base

Upstream bumps package versions in the first post-tag
`chore(release): prepare vX` commit:

```sh
prepare_commit=$(git log --format='%H %s' "$release_commit..upstream/main" \
  | grep -m1 'chore(release): prepare' | cut -d' ' -f1)
```

If no prepare commit exists yet, use `$release_commit` as the base and flag
the missing version bump in the report.

## Rebase on a sync branch

```sh
git switch main
git pull --ff-only origin main
old_base=$(git merge-base main upstream/main)
git log --oneline "$old_base"..main > /tmp/fork-stack-before.txt
git switch -c "sync/upstream-${release_tag#v}"
GIT_SEQUENCE_EDITOR="sed -i '/chore(release): prepare v/d'" \
  git rebase -i --empty=drop --onto "$prepare_commit" "$old_base"
```

The sequence editor removes the fork's own stale `chore(release): prepare`
commit from the replay; the new base carries the new version. `--empty=drop`
retires fork commits whose changes upstream now carries.

On conflict, the rebase stops at the exact fork commit in question. Resolve
per the SKILL.md principles, then:

```sh
git add <resolved files>
git rebase --continue
```

`git rebase --abort` returns to the untouched branch at any point; prefer
aborting and reporting over guessing through a conflict.

## Verify

```sh
git merge-base --is-ancestor "$prepare_commit" HEAD
git log --oneline "$prepare_commit"..HEAD
grep '"version"' apps/desktop/package.json
git diff --check
vp i                                      # when manifests or lockfile changed
vp run build:desktop                      # or leave to the Windows helper
```

Compare `git log --oneline "$prepare_commit"..HEAD` against
`/tmp/fork-stack-before.txt`: every commit from the before-list must appear,
or have been deliberately dropped as superseded. Then run focused checks for
every conflicted area.

## Publish

```sh
git branch "backup/pre-sync-${release_tag#v}" main        # while main is old
git switch main
git reset --hard "sync/upstream-${release_tag#v}"
git push --force-with-lease origin main
git branch -D "sync/upstream-${release_tag#v}"
```

`backup/pre-sync-*` keeps the previous tip for rollback
(`git reset --hard backup/pre-sync-<tag>` and force-push again). Skip these
steps only for an explicitly local-only trial, dry run, or build-only
operation.

## Build and install on Windows

Run from WSL after the rebase result is validated:

```sh
./build-install-windows.sh               # build, install, relaunch, verify
./build-install-windows.sh --preflight   # prerequisites only
./build-install-windows.sh --build-only  # no installation
```

One-time prerequisites: repo-pinned Vite+ toolchain, Windows Rust/MSVC
tooling, PowerShell, and working 64/32-bit Wine for Electron Builder's
packaging step. The helper does not install system packages.

The installed fork replaces the standard per-user T3 installation and shares
normal Windows and WSL state with official builds. The helper closes the
exact installed executable and backs up `~/.t3`, `%APPDATA%/t3code`, and
`%APPDATA%/T3 Code (Alpha)` when present. It does not support simultaneous
official and forked WSL backends or a side-by-side fork package.

## Future CI boundary

This manual workflow is the specification for later automation: a scheduled
job can detect a release, rebase the fork stack, and run builds. It must stop
on conflicts rather than invent resolutions; conflict resolution and
superseded-commit retirement need judgment.
