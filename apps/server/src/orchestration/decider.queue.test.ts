import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationQueuedComposerState,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:01.000Z";
const PROJECT_ID = ProjectId.make("project-queue");
const THREAD_ID = ThreadId.make("thread-queue");

const eventBase = (input: {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly commandId: string;
}) => ({
  sequence: input.sequence,
  eventId: EventId.make(input.eventId),
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make(input.aggregateId),
  occurredAt: NOW,
  commandId: CommandId.make(input.commandId),
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const seedReadModel = Effect.gen(function* () {
  const project = yield* projectEvent(createEmptyReadModel(NOW), {
    ...eventBase({
      sequence: 1,
      eventId: "event-project-created",
      aggregateId: "project-queue",
      commandId: "command-project-created",
    }),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Queue project",
      workspaceRoot: "/tmp/queue-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return yield* projectEvent(project, {
    ...eventBase({
      sequence: 2,
      eventId: "event-thread-created",
      aggregateId: "thread-queue",
      commandId: "command-thread-created",
    }),
    type: "thread.created",
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Queue thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

function queueCommand(
  suffix: string,
  createdAt = NOW,
  composerState?: OrchestrationQueuedComposerState,
) {
  return {
    type: "thread.turn.queue" as const,
    commandId: CommandId.make(`command-queue-${suffix}`),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(`message-${suffix}`),
      role: "user" as const,
      text: `Queued ${suffix}`,
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    ...(composerState !== undefined ? { composerState } : {}),
    createdAt,
  };
}

function sessionEvent(status: OrchestrationSessionStatus, sequence: number) {
  return {
    ...eventBase({
      sequence,
      eventId: `event-session-${status}-${sequence}`,
      aggregateId: "thread-queue",
      commandId: `command-session-${status}-${sequence}`,
    }),
    type: "thread.session-set" as const,
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: status === "running" ? TurnId.make("turn-active") : null,
        lastError: null,
        updatedAt: NOW,
      },
    },
  };
}

function applyPlanned(
  readModel: OrchestrationReadModel,
  planned:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Effect.gen(function* () {
    let next = readModel;
    for (const event of Array.isArray(planned) ? planned : [planned]) {
      next = yield* projectEvent(next, {
        ...event,
        sequence: next.snapshotSequence + 1,
      });
    }
    return next;
  });
}

it.layer(NodeServices.layer)("queue turn decider", (it) => {
  it.effect("sends immediately when completion wins the queueing race", () =>
    Effect.gen(function* () {
      const planned = yield* decideOrchestrationCommand({
        command: queueCommand("idle"),
        readModel: yield* seedReadModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("queues and drains messages in FIFO order after the turn settles", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, sessionEvent("running", 3));

      const firstComposerState: OrchestrationQueuedComposerState = {
        prompt: "Queued first",
        previewText: "Queued first",
        terminalContexts: [],
        elementContexts: [],
        previewAnnotations: [],
        reviewComments: [],
      };
      for (const suffix of ["first", "second"]) {
        const planned = yield* decideOrchestrationCommand({
          command: queueCommand(suffix, NOW, suffix === "first" ? firstComposerState : undefined),
          readModel,
        });
        expect(Array.isArray(planned) ? planned : [planned]).toHaveLength(1);
        readModel = yield* applyPlanned(readModel, planned);
      }

      const queued = readModel.threads[0]?.queuedMessages;
      expect(queued?.map((message) => message.messageId)).toEqual([
        MessageId.make("message-first"),
        MessageId.make("message-second"),
      ]);
      expect(queued?.[0]?.composerState).toEqual(firstComposerState);

      readModel = yield* projectEvent(
        readModel,
        sessionEvent("ready", readModel.snapshotSequence + 1),
      );
      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queue.drain",
          commandId: CommandId.make("command-queue-drain"),
          threadId: THREAD_ID,
          createdAt: LATER,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.queued-message-removed",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const sentEvent = events.find((event) => event.type === "thread.message-sent");
      expect(sentEvent?.type === "thread.message-sent" ? sentEvent.payload.createdAt : null).toBe(
        LATER,
      );

      const afterDrain = yield* applyPlanned(readModel, planned);
      expect(afterDrain.threads[0]?.messages.map((message) => message.id)).toContain(
        MessageId.make("message-first"),
      );
      expect(afterDrain.threads[0]?.queuedMessages.map((message) => message.messageId)).toEqual([
        MessageId.make("message-second"),
      ]);
    }),
  );

  it.effect("keeps a new message behind an existing queue during completion races", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, sessionEvent("running", 3));
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({
          command: queueCommand("first"),
          readModel,
        }),
      );
      readModel = yield* projectEvent(
        readModel,
        sessionEvent("ready", readModel.snapshotSequence + 1),
      );

      const planned = yield* decideOrchestrationCommand({
        command: queueCommand("second", LATER),
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];

      expect(events.map((event) => event.type)).toEqual(["thread.message-queued"]);
      const afterQueue = yield* applyPlanned(readModel, planned);
      expect(afterQueue.threads[0]?.messages).toEqual([]);
      expect(afterQueue.threads[0]?.queuedMessages.map((message) => message.messageId)).toEqual([
        MessageId.make("message-first"),
        MessageId.make("message-second"),
      ]);
    }),
  );

  it.effect("removes a queued message without dispatching it", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* projectEvent(readModel, sessionEvent("running", 3));
      readModel = yield* applyPlanned(
        readModel,
        yield* decideOrchestrationCommand({
          command: queueCommand("remove"),
          readModel,
        }),
      );

      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.queue.remove",
          commandId: CommandId.make("command-queue-remove"),
          threadId: THREAD_ID,
          messageId: MessageId.make("message-remove"),
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual(["thread.queued-message-removed"]);

      const afterRemove = yield* applyPlanned(readModel, planned);
      expect(afterRemove.threads[0]?.queuedMessages).toEqual([]);
      expect(afterRemove.threads[0]?.messages).toEqual([]);
    }),
  );
});
