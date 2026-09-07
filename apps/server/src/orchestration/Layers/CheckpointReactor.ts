import {
  CommandId,
  CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import { parseGitNumstat } from "../../vcs/gitDiff.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TurnBaseline {
  readonly cwd: string;
  turnId: TurnId | null;
  checkpointRef: CheckpointRef | null;
}

type ReactorInput =
  | {
      readonly source: "prepare";
      readonly threadId: ThreadId;
      readonly createdAt: string;
      readonly done: Deferred.Deferred<void>;
    }
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const turnBaselines = new Map<ThreadId, TurnBaseline>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // Capture the completed turn's files, then publish its summary and receipts.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const baseline = turnBaselines.get(input.threadId);
    const turnBaselineCheckpointRef =
      baseline?.turnId === input.turnId ? baseline.checkpointRef : null;
    const fromCheckpointExists = turnBaselineCheckpointRef !== null;
    const status = fromCheckpointExists ? input.status : "error";
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
      turnBaselineCheckpointRef,
    });
    turnBaselines.delete(input.threadId);

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
            useTurnBaseline: true,
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseGitNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: fromCheckpointExists ? "info" : "error",
        kind: fromCheckpointExists ? "checkpoint.captured" : "checkpoint.diff.unavailable",
        summary: fromCheckpointExists
          ? "Checkpoint captured"
          : "Turn diff unavailable: overlapping turns or missing starting snapshot. Restore checkpoint saved.",
        payload: {
          turnCount: input.turnCount,
          status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const captureTurnBaseline = Effect.fn("captureTurnBaseline")(function* (
    threadId: ThreadId,
    createdAt: string,
  ) {
    const active = turnBaselines.get(threadId);
    // Sending a message to a running provider can steer its existing turn.
    if (active?.turnId && sameId(startedTurns.get(threadId), active.turnId)) return;
    turnBaselines.delete(threadId);
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) return;
    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) return;
    const cwd = yield* fileSystem.realPath(checkpointCwd);
    const baseline: TurnBaseline = { cwd, turnId: null, checkpointRef: null };
    let overlaps = false;
    const within = (value: string) =>
      value === "" ||
      (value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
    for (const other of turnBaselines.values()) {
      const relative = path.relative(cwd, other.cwd);
      const reverse = path.relative(other.cwd, cwd);
      if (within(relative) || within(reverse)) {
        other.checkpointRef = null;
        overlaps = true;
      }
    }
    turnBaselines.set(threadId, baseline);
    const checkpointRef = CheckpointRef.make(`${checkpointRefForThreadTurn(threadId, 0)}-start`);
    yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
    if (!overlaps) baseline.checkpointRef = checkpointRef;
    else
      yield* Effect.logWarning(
        "turn diff attribution unavailable for overlapping workspace turns",
        { threadId, cwd },
      );

    const initialRef = checkpointRefForThreadTurn(threadId, 0);
    if (
      thread.checkpoints.length === 0 &&
      !(yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef: initialRef }))
    ) {
      const copied = yield* (
        checkpointStore.copyCheckpointRef?.({
          cwd,
          sourceCheckpointRef: checkpointRef,
          targetCheckpointRef: initialRef,
        }) ?? Effect.succeed(false)
      );
      if (!copied) yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: initialRef });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId,
        checkpointTurnCount: 0,
        checkpointRef: initialRef,
        createdAt,
      });
    }
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId || !sameId(startedTurns.get(event.threadId), turnId)) return;
      if (!turnBaselines.has(event.threadId)) {
        yield* captureTurnBaseline(event.threadId, event.createdAt);
      }
      const baseline = turnBaselines.get(event.threadId);
      if (baseline) baseline.turnId = turnId;
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to refresh git status after turn completion", {
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.metadata.historyImport === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      event.payload.turnCount === 0
        ? checkpointRefForThreadTurn(event.payload.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
          )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    const chronologicalTurns = yield* projectionTurnRepository.listChronologicallyByThreadId({
      threadId: event.payload.threadId,
    });
    const concreteTurns = chronologicalTurns.filter((turn) => turn.turnId !== null);
    const retainedTurnIndex =
      event.payload.turnCount === 0
        ? -1
        : concreteTurns.findIndex((turn) => turn.checkpointTurnCount === event.payload.turnCount);
    if (event.payload.turnCount > 0 && retainedTurnIndex < 0) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Projection turn for checkpoint ${event.payload.turnCount} is unavailable.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const discardedTurns = concreteTurns.slice(retainedTurnIndex + 1);
    const firstDiscardedTurnId = discardedTurns[0]?.turnId ?? undefined;

    const session = yield* providerService.ensureSession(event.payload.threadId);
    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd =
      session.cwd ??
      resolveThreadWorkspaceCwd({
        thread,
        projects,
      });
    if (!checkpointCwd || !(yield* checkpointStore.isGitRepository(checkpointCwd))) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    if (
      event.payload.turnCount > 0 &&
      !(yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: targetCheckpointRef,
      }))
    ) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      });
      return;
    }

    const rolledBackTurns = discardedTurns.length;
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: event.payload.threadId,
        numTurns: rolledBackTurns,
        ...(firstDiscardedTurnId !== undefined ? { beforeTurnId: firstDiscardedTurnId } : {}),
      });
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: event.payload.turnCount === 0,
    });
    if (!restored) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects the reverted filesystem state.
    yield* workspaceEntries.refresh(checkpointCwd);

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
      }
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: checkpointCwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.session-set") {
      if (
        (event.payload.session.status === "error" || event.payload.session.status === "stopped") &&
        turnBaselines.get(event.payload.threadId)?.turnId === null
      ) {
        turnBaselines.delete(event.payload.threadId);
      }
      return;
    }
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      turnBaselines.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn;
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (turnBaselines.get(event.threadId)?.turnId === turnId)
              turnBaselines.delete(event.threadId);
          }),
        ),
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "prepare"
      ? captureTurnBaseline(input.threadId, input.createdAt).pipe(
          Effect.ensuring(Deferred.succeed(input.done, undefined)),
        )
      : input.source === "domain"
        ? processDomainEvent(input.event)
        : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.source === "prepare" ? "prepare-turn" : input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.session-set" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    prepareTurn: Effect.fn("CheckpointReactor.prepareTurn")(function* (threadId, createdAt) {
      const done = yield* Deferred.make<void>();
      yield* worker.enqueue({ source: "prepare", threadId, createdAt, done });
      yield* Deferred.await(done);
    }),
    start,
    drain: worker.drain.pipe(Effect.andThen(statusRefreshWorker.drain)),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
