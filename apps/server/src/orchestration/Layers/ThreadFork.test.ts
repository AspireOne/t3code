import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { projectEvent } from "../projector.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const testLayer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-selected-" })),
  Layer.provideMerge(NodeServices.layer),
);

type EventContent = {
  [K in OrchestrationEvent["type"]]: Pick<
    Extract<OrchestrationEvent, { type: K }>,
    "type" | "payload"
  >;
}[OrchestrationEvent["type"]];
const NOW = "2026-01-01T00:00:00.000Z";
const FORK_AT = "2026-01-01T01:00:00.000Z";

it.layer(testLayer)("selected fork persistence and replay", (it) => {
  it.effect("forks old durable history after restart, replays it, and can fork the fork", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const store = yield* OrchestrationEventStore;
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const sourceId = ThreadId.make("source-history");
      const targetId = ThreadId.make("target-history");
      const nestedId = ThreadId.make("nested-history");
      let sequence = 0;
      const emit = Effect.fn("emitForkFixtureEvent")(function* (content: EventContent, at: string) {
        const event = yield* store.append({
          ...content,
          eventId: EventId.make(`source-event-${++sequence}`),
          aggregateKind: "thread",
          aggregateId: sourceId,
          occurredAt: at,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        });
        yield* pipeline.projectEvent(event);
      });
      yield* emit(
        {
          type: "thread.created",
          payload: {
            threadId: sourceId,
            projectId: ProjectId.make("project-fork"),
            title: "Original",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        NOW,
      );
      for (const n of [1, 2, 3]) {
        const turnId = TurnId.make(`turn-${n}`);
        const promptId = MessageId.make(`prompt-${n}`);
        const responseId = MessageId.make(`response-${n}`);
        const start = `2026-01-01T00:0${n}:00.000Z`;
        const end = `2026-01-01T00:0${n}:30.000Z`;
        yield* emit(
          {
            type: "thread.message-sent",
            payload: {
              threadId: sourceId,
              messageId: promptId,
              role: "user",
              text: `Prompt ${n}`,
              turnId: null,
              streaming: false,
              createdAt: start,
              updatedAt: start,
            },
          },
          start,
        );
        yield* emit(
          {
            type: "thread.turn-start-requested",
            payload: {
              threadId: sourceId,
              messageId: promptId,
              createdAt: start,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          },
          start,
        );
        yield* emit(
          {
            type: "thread.session-set",
            payload: {
              threadId: sourceId,
              session: {
                threadId: sourceId,
                providerName: "Codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                status: "running",
                runtimeMode: "full-access",
                activeTurnId: turnId,
                lastError: null,
                updatedAt: start,
              },
            },
          },
          start,
        );
        yield* emit(
          {
            type: "thread.message-sent",
            payload: {
              threadId: sourceId,
              messageId: responseId,
              role: "assistant",
              text: `Response ${n}`,
              turnId,
              streaming: false,
              createdAt: end,
              updatedAt: end,
            },
          },
          end,
        );
        yield* emit(
          {
            type: "thread.proposed-plan-upserted",
            payload: {
              threadId: sourceId,
              proposedPlan: {
                id: `plan-${n}` as OrchestrationProposedPlanId,
                turnId,
                planMarkdown: `Plan ${n}`,
                createdAt: end,
                updatedAt: end,
                implementedAt: null,
                implementationThreadId: null,
              },
            },
          },
          end,
        );
        yield* emit(
          {
            type: "thread.activity-appended",
            payload: {
              threadId: sourceId,
              activity: {
                id: EventId.make(`activity-${n}`),
                turnId,
                kind: "tool.completed",
                summary: `Tool ${n}`,
                tone: "tool",
                payload: {},
                createdAt: end,
              },
            },
          },
          end,
        );
        yield* emit(
          {
            type: "thread.turn-diff-completed",
            payload: {
              threadId: sourceId,
              turnId,
              checkpointTurnCount: n,
              checkpointRef: checkpointRefForThreadTurn(sourceId, n),
              assistantMessageId: responseId,
              status: "ready",
              files: [],
              completedAt: end,
            },
          },
          end,
        );
        yield* emit(
          {
            type: "thread.session-set",
            payload: {
              threadId: sourceId,
              session: {
                threadId: sourceId,
                providerName: "Codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                status: "ready",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: end,
              },
            },
          },
          end,
        );
      }
      // A later implementation must not mark the plan implemented in an earlier fork.
      yield* emit(
        {
          type: "thread.proposed-plan-upserted",
          payload: {
            threadId: sourceId,
            proposedPlan: {
              id: "plan-1" as OrchestrationProposedPlanId,
              turnId: TurnId.make("turn-1"),
              planMarkdown: "Plan 1",
              createdAt: "2026-01-01T00:01:30.000Z",
              updatedAt: "2026-01-01T00:03:30.000Z",
              implementedAt: "2026-01-01T00:03:30.000Z",
              implementationThreadId: sourceId,
            },
          },
        },
        "2026-01-01T00:03:30.000Z",
      );
      const recent = yield* query.getThreadDetailSnapshot(sourceId, { turnLimit: 1 });
      if (Option.isNone(recent)) throw new Error("Expected paginated source");
      assert.deepEqual(
        recent.value.thread.messages.map((message) => message.text),
        ["Prompt 3", "Response 3"],
      );
      const fork = Effect.fn("dispatchSelectedForkFixture")(function* (
        sourceThreadId: ThreadId,
        targetThreadId: ThreadId,
        throughTurnId: TurnId,
      ) {
        const context = yield* query.getThreadForkContext(sourceThreadId, throughTurnId);
        assert.isTrue(Option.isSome(context));
        if (Option.isNone(context)) throw new Error("Expected fork context");
        const readModel = yield* query.getCommandReadModel();
        // This is the lightweight state used after restart: history is not loaded.
        assert.deepEqual(
          readModel.threads.find((thread) => thread.id === sourceThreadId)?.messages,
          [],
        );
        const decided = yield* decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.fork",
            commandId: CommandId.make(`fork-${targetThreadId}`),
            sourceThreadId,
            threadId: targetThreadId,
            throughTurnId,
            createdAt: FORK_AT,
            expectedSourceTurnId: context.value.source.latestTurn!.turnId,
            expectedSourceUpdatedAt: context.value.source.updatedAt,
            preparedFork: {
              latestTurn: context.value.latestTurn,
              historySelection: context.value.historySelection,
            },
          },
        });
        const event = Array.isArray(decided) ? decided[0]! : decided;
        const saved = yield* store.append(event);
        yield* pipeline.projectEvent(saved);
        const memory = yield* projectEvent(
          { ...readModel, threads: [context.value.source] },
          saved,
        );
        return memory.threads.find((thread) => thread.id === targetThreadId);
      });
      const memory = yield* fork(sourceId, targetId, TurnId.make("turn-2"));
      const assertTarget = Effect.fn("assertSelectedForkHistory")(function* () {
        const target = yield* query.getThreadDetailSnapshot(targetId);
        assert.isTrue(Option.isSome(target));
        if (Option.isNone(target)) throw new Error("Expected forked thread");
        const thread = target.value.thread;
        assert.deepEqual(
          thread.messages.map((message) => message.text),
          ["Prompt 1", "Response 1", "Prompt 2", "Response 2"],
        );
        assert.deepEqual(
          thread.messages.map((message) => message.id),
          memory!.messages.map((message) => message.id),
        );
        assert.deepEqual(
          thread.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
          [1, 2],
        );
        assert.deepEqual(
          thread.proposedPlans.map((plan) => plan.planMarkdown),
          ["Plan 1", "Plan 2"],
        );
        assert.equal(thread.proposedPlans[0]?.implementedAt, null);
        assert.equal(thread.proposedPlans[0]?.implementationThreadId, null);
        assert.deepEqual(
          thread.activities.map((activity) => activity.summary),
          ["Tool 1", "Tool 2"],
        );
        assert.deepEqual(thread.latestTurn, memory!.latestTurn);
        assert.equal(thread.latestTurn?.requestedAt, "2026-01-01T00:02:00.000Z");
        assert.equal(thread.session, null);
      });
      yield* assertTarget();
      yield* fork(targetId, nestedId, TurnId.make("turn-1"));
      const nested = yield* query.getThreadDetailById(nestedId);
      assert.isTrue(Option.isSome(nested));
      if (Option.isSome(nested))
        assert.deepEqual(
          nested.value.messages.map((message) => message.text),
          ["Prompt 1", "Response 1"],
        );
      const original = yield* query.getThreadDetailById(sourceId);
      if (Option.isNone(original)) throw new Error("Expected original thread");
      assert.equal(original.value.messages.length, 6);
      assert.equal(original.value.latestTurn?.turnId, "turn-3");
      assert.isTrue(
        Option.isNone(yield* query.getThreadForkContext(sourceId, TurnId.make("unknown"))),
      );

      // Rebuild projections from durable events, including the nested fork.
      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;
      yield* assertTarget();
      const replayedNested = yield* query.getThreadDetailById(nestedId);
      if (Option.isNone(replayedNested)) throw new Error("Expected replayed nested fork");
      assert.deepEqual(
        replayedNested.value.messages.map((message) => message.text),
        ["Prompt 1", "Response 1"],
      );
    }),
  );
});
