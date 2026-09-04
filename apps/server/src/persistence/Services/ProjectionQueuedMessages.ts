import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationProposedPlanId,
  OrchestrationQueuedComposerState,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueuedMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  composerState: Schema.NullOr(OrchestrationQueuedComposerState),
  queuedAt: IsoDateTime,
});
export type ProjectionQueuedMessage = typeof ProjectionQueuedMessage.Type;

export const ListProjectionQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionQueuedMessagesInput = typeof ListProjectionQueuedMessagesInput.Type;

export const DeleteProjectionQueuedMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type DeleteProjectionQueuedMessageInput = typeof DeleteProjectionQueuedMessageInput.Type;

export const DeleteProjectionQueuedMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionQueuedMessagesInput = typeof DeleteProjectionQueuedMessagesInput.Type;

export interface ProjectionQueuedMessageRepositoryShape {
  readonly upsert: (
    queuedMessage: ProjectionQueuedMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionQueuedMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedMessage>, ProjectionRepositoryError>;
  readonly deleteByMessageId: (
    input: DeleteProjectionQueuedMessageInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionQueuedMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionQueuedMessageRepository extends Context.Service<
  ProjectionQueuedMessageRepository,
  ProjectionQueuedMessageRepositoryShape
>()("t3/persistence/Services/ProjectionQueuedMessages/ProjectionQueuedMessageRepository") {}
