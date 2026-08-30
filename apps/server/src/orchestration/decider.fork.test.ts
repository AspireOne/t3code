import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SOURCE_ID = ThreadId.make("thread-source");
const TARGET_ID = ThreadId.make("thread-target");
const TURN_ID = TurnId.make("turn-1");
const MESSAGE_ID = MessageId.make("message-1");

function makeSource(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: SOURCE_ID,
    projectId: ProjectId.make("project-1"),
    title: "Original chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: TURN_ID,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: MESSAGE_ID,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MESSAGE_ID,
        role: "assistant",
        text: "Finished work",
        attachments: [],
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [
      {
        id: EventId.make("activity-1"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Done",
        payload: {},
        turnId: TURN_ID,
        createdAt: NOW,
      },
    ],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(source = makeSource()): OrchestrationReadModel {
  return {
    snapshotSequence: 4,
    projects: [],
    threads: [source],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread fork decider and projector", (it) => {
  it.effect("creates an independent target through the latest settled turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork"),
          sourceThreadId: SOURCE_ID,
          threadId: TARGET_ID,
          createdAt: NOW,
          expectedSourceTurnId: TURN_ID,
          expectedSourceUpdatedAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const forked = events[0];
      if (forked?.type !== "thread.forked") return;
      expect(forked.payload.forkedThroughTurnId).toBe(TURN_ID);
      expect(forked.payload.title).toBe("Original chat (fork)");

      const projected = yield* projectEvent(makeReadModel(), { ...forked, sequence: 5 });
      const source = projected.threads.find((thread) => thread.id === SOURCE_ID);
      const target = projected.threads.find((thread) => thread.id === TARGET_ID);
      expect(target?.messages.map((message) => message.text)).toEqual(["Finished work"]);
      expect(target?.messages[0]?.id).not.toBe(source?.messages[0]?.id);
      expect(target?.activities[0]?.id).not.toBe(source?.activities[0]?.id);
      expect(target?.latestTurn?.turnId).toBe(TURN_ID);
      expect(target?.latestTurn?.assistantMessageId).toBe(target?.messages[0]?.id);
      expect(target?.session).toBeNull();
    }),
  );

  it.effect("rejects a source without a completed turn and a running source", () =>
    Effect.gen(function* () {
      for (const source of [
        makeSource({ latestTurn: null }),
        makeSource({
          session: {
            threadId: SOURCE_ID,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: TURN_ID,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.fork",
            commandId: CommandId.make("cmd-fork-blocked"),
            sourceThreadId: SOURCE_ID,
            threadId: TARGET_ID,
            createdAt: NOW,
            expectedSourceTurnId: TURN_ID,
            expectedSourceUpdatedAt: NOW,
          },
          readModel: makeReadModel(source),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("rejects a fork prepared from an older source snapshot", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork-stale"),
          sourceThreadId: SOURCE_ID,
          threadId: TARGET_ID,
          createdAt: NOW,
          expectedSourceTurnId: TURN_ID,
          expectedSourceUpdatedAt: "2025-12-31T23:59:59.000Z",
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("changed while the fork was being prepared");
    }),
  );

  it.effect("remaps target-owned history references and clears source lifecycle state", () =>
    Effect.gen(function* () {
      const planId = "plan-source" as OrchestrationThread["proposedPlans"][number]["id"];
      const sourceAttachmentId = "thread-source-00000000-0000-4000-8000-000000000001-pdf";
      const source = makeSource({
        archivedAt: NOW,
        settledOverride: "settled",
        settledAt: NOW,
        snoozedUntil: NOW,
        snoozedAt: NOW,
        pinnedAt: NOW,
        pinOrderKey: "a0",
        latestTurn: {
          ...makeSource().latestTurn!,
          sourceProposedPlan: { threadId: SOURCE_ID, planId },
        },
        messages: [
          {
            ...makeSource().messages[0]!,
            attachments: [
              {
                type: "file",
                id: sourceAttachmentId,
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 12,
              },
            ],
          },
        ],
        proposedPlans: [
          {
            id: planId,
            turnId: TURN_ID,
            planMarkdown: "# Plan",
            implementedAt: NOW,
            implementationThreadId: SOURCE_ID,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        checkpoints: [
          {
            turnId: TURN_ID,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-source/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MESSAGE_ID,
            completedAt: NOW,
          },
        ],
      });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork-history"),
          sourceThreadId: SOURCE_ID,
          threadId: TARGET_ID,
          createdAt: NOW,
          expectedSourceTurnId: TURN_ID,
          expectedSourceUpdatedAt: NOW,
        },
        readModel: makeReadModel(source),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const event = events[0];
      if (event?.type !== "thread.forked") return;

      const projected = yield* projectEvent(makeReadModel(source), { ...event, sequence: 5 });
      const target = projected.threads.find((thread) => thread.id === TARGET_ID);
      const targetMessage = target?.messages[0];
      const targetPlan = target?.proposedPlans[0];

      expect(targetMessage?.attachments?.[0]?.id).toBe(
        "thread-target-00000000-0000-4000-8000-000000000001-pdf",
      );
      expect(source.messages[0]?.attachments?.[0]?.id).toBe(sourceAttachmentId);
      expect(targetPlan?.id).not.toBe(planId);
      expect(targetPlan?.implementationThreadId).toBe(TARGET_ID);
      expect(target?.latestTurn?.sourceProposedPlan).toEqual({
        threadId: TARGET_ID,
        planId: targetPlan?.id,
      });
      expect(target?.checkpoints[0]).toMatchObject({
        checkpointRef: checkpointRefForThreadTurn(TARGET_ID, 1),
        assistantMessageId: targetMessage?.id,
      });
      expect(target).toMatchObject({
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        session: null,
      });
    }),
  );
});
