import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { ServerConfig } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadCanFork, resolveThreadDetailRef } from "./entities";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

afterEach(() => {
  vi.restoreAllMocks();
});

function makeForkableShell(
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const now = "2026-08-30T12:00:00.000Z";
  return {
    environmentId: threadRef.environmentId,
    id: threadRef.threadId,
    projectId: ProjectId.make("project-1"),
    title: "Fork me",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-custom"),
      model: "gpt-5.6-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function mockForkState(shell: EnvironmentThreadShell, options?: { capability?: boolean }) {
  const threadAtom = environmentThreadShells.threadShellAtom(threadRef);
  const config = {
    environment: { capabilities: { threadForking: options?.capability ?? true } },
    providers: [{ instanceId: ProviderInstanceId.make("codex-custom"), driver: "codex" }],
  } as unknown as ServerConfig;
  vi.spyOn(appAtomRegistry, "get").mockImplementation(((atom: unknown) => {
    if (atom === environmentServerConfigsAtom) {
      return new Map([[threadRef.environmentId, config]]);
    }
    if (atom === threadAtom) return shell;
    throw new Error("Unexpected atom read in fork gating test");
  }) as never);
}

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("readThreadCanFork", () => {
  it("allows only a completed idle Codex thread on a capable environment", () => {
    mockForkState(makeForkableShell());
    expect(readThreadCanFork(threadRef)).toBe(true);
  });

  it.each([
    ["missing server capability", makeForkableShell(), false],
    [
      "running session",
      makeForkableShell({
        session: {
          threadId: threadRef.threadId,
          providerInstanceId: ProviderInstanceId.make("codex-custom"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-08-30T12:00:00.000Z",
        },
      }),
      true,
    ],
    ["pending approval", makeForkableShell({ hasPendingApprovals: true }), true],
    ["pending user input", makeForkableShell({ hasPendingUserInput: true }), true],
    ["no completed turn", makeForkableShell({ latestTurn: null }), true],
  ])("blocks %s", (_case, shell, capability) => {
    mockForkState(shell, { capability });
    expect(readThreadCanFork(threadRef)).toBe(false);
  });

  it("blocks a freshly queued user turn that the server would reject", () => {
    const queuedAt = new Date().toISOString();
    const priorTurnAt = new Date(Date.now() - 1_000).toISOString();
    mockForkState(
      makeForkableShell({
        latestUserMessageAt: queuedAt,
        latestTurn: {
          ...makeForkableShell().latestTurn!,
          requestedAt: priorTurnAt,
          startedAt: priorTurnAt,
          completedAt: priorTurnAt,
        },
      }),
    );

    expect(readThreadCanFork(threadRef)).toBe(false);
  });
});
