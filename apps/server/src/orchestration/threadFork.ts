import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  type OrchestrationThread,
  type OrchestrationLatestTurn,
  type ThreadForkHistorySelection,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";

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

export function selectThreadForkHistory(
  source: OrchestrationThread,
  turns: ReadonlyArray<ProjectionTurn>,
  throughTurnId: TurnId,
): { latestTurn: OrchestrationLatestTurn; historySelection: ThreadForkHistorySelection } | null {
  const selected = turns.find((turn) => turn.turnId === throughTurnId);
  if (
    !selected ||
    selected.completedAt === null ||
    selected.state === "pending" ||
    selected.state === "running"
  )
    return null;

  const completedAt = selected.completedAt;
  const retainedTurnIds = new Set<TurnId>();
  const messageTurnIds = new Map<MessageId, TurnId>();
  for (const turn of turns) {
    if (turn.turnId === null) continue;
    if (turn.pendingMessageId !== null) messageTurnIds.set(turn.pendingMessageId, turn.turnId);
    if (turn.assistantMessageId !== null) messageTurnIds.set(turn.assistantMessageId, turn.turnId);
    if (
      turn.turnId === throughTurnId ||
      (turn.checkpointTurnCount !== null && selected.checkpointTurnCount !== null
        ? turn.checkpointTurnCount < selected.checkpointTurnCount
        : (compareDateTimeStrings(turn.requestedAt, selected.requestedAt) ||
            turn.turnId.localeCompare(throughTurnId)) < 0)
    )
      retainedTurnIds.add(turn.turnId);
  }

  const includesHistory = (entry: { turnId: TurnId | null; createdAt: string }) =>
    entry.turnId === null
      ? compareDateTimeStrings(entry.createdAt, completedAt) <= 0
      : retainedTurnIds.has(entry.turnId);

  return {
    latestTurn: {
      turnId: throughTurnId,
      state: selected.state,
      requestedAt: selected.requestedAt,
      startedAt: selected.startedAt,
      completedAt,
      assistantMessageId: selected.assistantMessageId,
      ...(selected.sourceProposedPlanThreadId !== null && selected.sourceProposedPlanId !== null
        ? {
            sourceProposedPlan: {
              threadId: selected.sourceProposedPlanThreadId,
              planId: selected.sourceProposedPlanId,
            },
          }
        : {}),
    },
    historySelection: {
      turnIds: [...retainedTurnIds],
      messageIds: source.messages
        .filter((message) =>
          includesHistory({
            ...message,
            turnId: messageTurnIds.get(message.id) ?? message.turnId,
          }),
        )
        .map((message) => message.id),
      proposedPlanIds: source.proposedPlans
        .filter(
          (plan) =>
            includesHistory(plan) && compareDateTimeStrings(plan.createdAt, completedAt) <= 0,
        )
        .map((plan) => plan.id),
      activityIds: source.activities
        .filter(
          (activity) =>
            includesHistory(activity) &&
            compareDateTimeStrings(activity.createdAt, completedAt) <= 0,
        )
        .map((activity) => activity.id),
    },
  };
}

/** The same frozen selection owns resource preparation and both projectors. */
export function selectForkSource(
  source: OrchestrationThread,
  selection: ThreadForkHistorySelection | undefined,
): OrchestrationThread {
  if (selection === undefined) return source;
  const messageIds = new Set(selection.messageIds);
  const planIds = new Set(selection.proposedPlanIds);
  const activityIds = new Set(selection.activityIds);
  const turnIds = new Set(selection.turnIds);
  return {
    ...source,
    messages: source.messages.filter((message) => messageIds.has(message.id)),
    proposedPlans: source.proposedPlans.filter((plan) => planIds.has(plan.id)),
    activities: source.activities.filter((activity) => activityIds.has(activity.id)),
    checkpoints: source.checkpoints.filter((checkpoint) => turnIds.has(checkpoint.turnId)),
  };
}

export function forkedPlanImplementation(
  plan: Pick<
    OrchestrationThread["proposedPlans"][number],
    "implementedAt" | "implementationThreadId"
  >,
  event: Extract<OrchestrationEvent, { type: "thread.forked" }>,
) {
  const cutoff = event.payload.latestTurn.completedAt;
  if (
    event.payload.historySelection !== undefined &&
    cutoff !== null &&
    plan.implementedAt !== null &&
    compareDateTimeStrings(plan.implementedAt, cutoff) > 0
  ) {
    return { implementedAt: null, implementationThreadId: null };
  }
  return {
    implementedAt: plan.implementedAt,
    implementationThreadId:
      plan.implementationThreadId === event.payload.sourceThreadId
        ? event.payload.threadId
        : plan.implementationThreadId,
  };
}

export function cloneThreadForFork(
  source: OrchestrationThread,
  event: Extract<OrchestrationEvent, { type: "thread.forked" }>,
): OrchestrationThread {
  source = selectForkSource(source, event.payload.historySelection);
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
    branchPullRequest: null,
    activeOrderKey: null,
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
      ...forkedPlanImplementation(plan, event),
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
