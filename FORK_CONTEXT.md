# Fork context

This repository is AspireOne's fork of
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), an open-source GUI
and server for running coding-agent providers across web, desktop, and mobile
clients. It exists to carry a small number of focused fixes while remaining as
close to upstream as practical.

The initial motivation was
[#2441](https://github.com/pingdotgg/t3code/issues/2441): diffs and checkpoints
can fail when a T3 workspace is a subdirectory of its Git repository. The
workspace must remain rooted at that subdirectory; changing the project to the
Git top-level is not an acceptable workaround. This fork now carries the
nested-workspace review and checkpoint fix.

The fork currently adds a desktop notification when a newer stable upstream
release is available. It does not download, merge, build, or install updates;
release synchronization remains the explicit workflow documented below.

Fork builds should preserve normal T3 behavior, including Codex, Windows/WSL,
and T3's production Connect infrastructure; they must not introduce client
secrets or an unnecessary self-hosted relay. Packaged official and fork builds
currently share T3's normal Windows and WSL state, so use only one at a time,
back up persistent state before switching versions, and keep development runs
isolated. Build and synchronization commands are recorded in
[`FORK-MAINTENANCE.md`](./FORK-MAINTENANCE.md).
