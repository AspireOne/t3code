import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import { forkAttachmentForThread } from "../attachmentStore.ts";

export function forkedEntityId(
  targetThreadId: ThreadId,
  kind: "activity" | "message" | "plan",
  sourceId: string,
): string {
  return `fork:${targetThreadId}:${kind}:${sourceId}`;
}

export function forkedThreadTitle(sourceTitle: string): string {
  return `${sourceTitle} (fork)`;
}

export function cloneThreadForFork(
  source: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.forked" }>,
): OrchestrationThread {
  const targetThreadId = event.payload.threadId;
  const remapMessageId = (messageId: string) =>
    MessageId.make(forkedEntityId(targetThreadId, "message", messageId));

  return {
    id: targetThreadId,
    projectId: event.payload.projectId,
    title: event.payload.title,
    modelSelection: event.payload.modelSelection,
    runtimeMode: event.payload.runtimeMode,
    interactionMode: event.payload.interactionMode,
    branch: event.payload.branch,
    worktreePath: event.payload.worktreePath,
    linkedPullRequest: null,
    latestTurn: {
      ...event.payload.latestTurn,
      assistantMessageId:
        event.payload.latestTurn.assistantMessageId === null
          ? null
          : remapMessageId(event.payload.latestTurn.assistantMessageId),
      ...(event.payload.latestTurn.sourceProposedPlan === undefined
        ? {}
        : {
            sourceProposedPlan:
              event.payload.latestTurn.sourceProposedPlan.threadId === source.id
                ? {
                    threadId: targetThreadId,
                    planId: forkedEntityId(
                      targetThreadId,
                      "plan",
                      event.payload.latestTurn.sourceProposedPlan.planId,
                    ) as OrchestrationProposedPlanId,
                  }
                : event.payload.latestTurn.sourceProposedPlan,
          }),
    },
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: source.messages.map((message) => ({
      ...message,
      id: remapMessageId(message.id),
      attachments: (message.attachments ?? [])
        .map((attachment) => forkAttachmentForThread(attachment, targetThreadId))
        .filter((attachment) => attachment !== null),
      streaming: false,
    })),
    queuedMessages: [],
    pendingTurnStart: null,
    proposedPlans: source.proposedPlans.map((plan) => ({
      ...plan,
      id: forkedEntityId(targetThreadId, "plan", plan.id) as OrchestrationProposedPlanId,
      implementationThreadId:
        plan.implementationThreadId === source.id ? targetThreadId : plan.implementationThreadId,
    })),
    activities: source.activities.map((activity) => ({
      ...activity,
      id: EventId.make(forkedEntityId(targetThreadId, "activity", activity.id)),
    })),
    checkpoints: source.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      checkpointRef: checkpointRefForThreadTurn(targetThreadId, checkpoint.checkpointTurnCount),
      assistantMessageId:
        checkpoint.assistantMessageId === null
          ? null
          : remapMessageId(checkpoint.assistantMessageId),
    })),
    session: null,
  };
}
