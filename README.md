# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## AspireOne fork additions

Compared with the upstream release this fork tracks, the notable fork work is:

- Windows/WSL build and install workflow: `build-install-windows.sh` builds
  from WSL, stages installers outside WSL, supplies WSL `node-pty` resources,
  validates artifacts and health, backs up state, and tolerates delayed
  installation relaunches.
- Fast, safe Windows packaging: verified source/toolchain-keyed build and
  dependency caches, same-version WSL bundle refreshes, isolated packaging
  copies, checksums, timings, retries, and bounded cache retention.
- WSL authentication: forwards the Windows/WSL `SSH_AUTH_SOCK` into
  WSL-hosted server backends.
- Windows system tray: closing the desktop window hides it while T3 Code keeps
  running; tray **Open**/**Close** actions and updater/session shutdown paths
  remain clean.
- Upstream-release awareness: desktop checks for newer stable upstream
  releases, shows a persistent notification, and links directly to the exact
  release; synchronization, build, and install remain explicit maintainer
  steps.
- Nested project workspaces: Git status, untracked files, checkpoints,
  reviews, and source-control operations work when a project is below its
  repository root.
- Git status at a glance: the branch toolbar shows staged, modified, deleted,
  renamed, untracked, conflicted, ahead, and behind counts, and its status
  control refreshes status after workspace changes and opens the working-tree
  diff.
- Pull-request and status UI fixes: closed or merged PRs no longer occupy the
  composer PR pill, while remaining available from the sidebar.
- Turn-scoped review checkpoints: turn diffs use the turn's own baseline and
  exclude edits made between turns; overlapping turns are reported as
  unavailable for attribution while restore checkpoints remain available.
- Diff and VCS fidelity: preserve exact paths and renames, repeated-path
  records, initial-commit changes, parsed directory paths, and patch ordering;
  refresh after workspace mutations, isolate replacement/content caches, and
  disclose truncated diffs.
- Codex conversation branching: `/fork`, **Fork thread**, and **Fork through
  this turn** create independent conversations with the selected history,
  attachments, and checkpoints on web, desktop, and mobile without rewinding
  the shared workspace.
- Safer Codex reverts: recover stopped sessions, revert paginated threads by
  exact turn boundaries, and remove reverted user prompts from the live
  timeline.
- Durable follow-up queues: queue messages while an agent works, retain
  attachments and composer context, deliver them in order after successful
  turns, and remove or move queued items back for editing; `/compact` cannot be
  queued, and removed queued items do not leave stale pending messages behind.
- Custom thread titles: configure the instructions used to generate automatic
  thread titles.
- Quick thread rename: **Rename thread** in the command palette opens the
  sidebar's inline editor, including hidden or lazily mounted mobile sidebars,
  while preserving title-field focus.
- Desktop thread actions: **Delete thread** is available for the active thread
  in the command palette, and **Restart T3 Code** gracefully relaunches the
  desktop app with duplicate requests made single-flight.
- Floating command-menu preselection: the command palette automatically selects
  the first enabled result, preserves a still-visible explicit selection, and
  keeps a valid result selected while query/deferred-query results change;
  browsing and remote-clone flows intentionally opt out.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
