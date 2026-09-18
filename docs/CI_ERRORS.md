# Local CI errors

Run date: 2026-08-30

This records the still-active issues from the local repository CI run for the
chat-fork changes. They are outside the fork scope; no fork-related failure
was observed.

## CI command availability

The workflow invokes bare `vpr typecheck`, but `vpr` is not on this shell's
interactive `PATH` (`zsh: command not found: vpr`). The checkout does provide
the repository-local `node_modules/.bin/vpr` shim from Vite Plus, so no global
installation is needed. The equivalent `vp run typecheck` completed
successfully for all 15 packages.

## Active test failure

### Server shard 2: Provider registry re-probe

Command: `vp run --filter t3 test --shard 2/3`

`apps/server/src/provider/Layers/ProviderRegistry.test.ts` failed:

- `re-probes when settings change the codex binaryPath`

The test observed only the first mocked executable invocation instead of the
expected second invocation. This is a provider-registry probe test and is
unrelated to the Codex chat-fork path.

## Passing CI sections from the original run

- Electron runtime check.
- `vp check` (format and lint; warnings were pre-existing and outside fork
  scope).
- `vp run typecheck` for all 15 packages.
- Web/server/desktop production build and preload-bundle verification.
- Web unit tests after the follow-up fixes: 2,949 passed.
- GitManager tests after the follow-up fix: 86 passed.
- Server shard 3: 1,076 passed, 7 skipped.
- Rust format check and 15 native tests.
