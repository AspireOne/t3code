# Manual release update

Use this reference for the current command-level workflow. Re-check upstream
documentation and scripts before executing it after a future release.

## Resolve the upstream release

Use the available GitHub CLI (`gh` in WSL or `gh.exe` from Windows):

```sh
gh_command=gh
command -v gh >/dev/null 2>&1 || gh_command=gh.exe
"$gh_command" api repos/pingdotgg/t3code/releases/latest \
  --jq '{tag: .tag_name, commit: .target_commitish, published: .published_at}'
```

`releases/latest` selects the latest stable release. For an explicitly
requested nightly, inspect `gh release list --repo pingdotgg/t3code` and select
the intended prerelease tag rather than guessing from local tags.

Fetch and verify the tag:

```sh
git fetch upstream main --tags --prune
release_tag=v0.0.XX
release_commit=$(git rev-parse "$release_tag^{commit}")
git merge-base --is-ancestor "$release_commit" upstream/main
```

Stop if the tag is missing, is not reachable from upstream history, or does not
match the selected GitHub release.

## Merge on an integration branch

Start only from a clean fork `main`:

```sh
git switch main
git pull --ff-only origin main
git switch -c "sync/upstream-${release_tag#v}"
git merge --no-edit "$release_tag"
```

If conflicts occur, inspect the conflicting commits and current upstream code.
Resolve the fork's intent on top of the released implementation, stage only the
resolved files, and continue the merge. Abort and report rather than making an
uncertain semantic choice.

Verify the result:

```sh
git merge-base --is-ancestor "$release_commit" HEAD
git log --oneline "$release_commit"..HEAD
git diff --check
vp i
vp run build:desktop # omit when the Windows artifact helper runs next
```

Run focused checks for conflict-affected areas. Do not fix unrelated failures
or the nested-workspace bug as part of a release sync.

After validation, complete the normal update by fast-forwarding `main`, pushing
the fork remote, and deleting the temporary local branch:

```sh
git switch main
git merge --ff-only "sync/upstream-${release_tag#v}"
git push origin main
git branch -d "sync/upstream-${release_tag#v}"
```

Only omit these final steps when the user explicitly requested a local-only
trial, dry run, or build-only operation.

## Build and install on Windows

The helper is intended to be run from WSL after the merge result is clean:

```sh
.agents/skills/updating-t3-fork/scripts/build-install-windows.sh
```

Useful modes:

```sh
# Validate prerequisites without building or changing the installation.
.agents/skills/updating-t3-fork/scripts/build-install-windows.sh --preflight

# Build and validate the artifact, leaving the running installation untouched.
.agents/skills/updating-t3-fork/scripts/build-install-windows.sh --build-only

# Build, back up state, install, and relaunch without waiting for WSL health.
.agents/skills/updating-t3-fork/scripts/build-install-windows.sh --no-verify
```

Current one-time prerequisites are the repo-pinned Vite+ toolchain, Windows
Rust/MSVC tooling, PowerShell, and Wine in WSL for Electron Builder's Windows
resource-editing step. The helper deliberately does not install system
packages.

The installed fork currently replaces the standard per-user T3 installation
and shares normal Windows and WSL state with official builds. The helper closes
the exact installed executable and backs up `%APPDATA%/t3code` and `~/.t3`
before installation. It does not support simultaneous official and forked WSL
backends or a side-by-side fork package.

## Future CI boundary

The manual workflow is the executable specification for later automation. A
scheduled workflow can detect a new stable release, fetch its tag, create a
sync branch, attempt the merge, run builds, and open or update a reviewable pull
request. It should stop on conflicts rather than invent resolutions or push a
conflicted merge directly to `main`; conflict resolution and local patch
retirement still require judgment.
