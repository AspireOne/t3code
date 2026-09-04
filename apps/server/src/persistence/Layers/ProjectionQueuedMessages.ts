import {
  ChatAttachment,
  ModelSelection,
  OrchestrationQueuedComposerState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionQueuedMessageInput,
  DeleteProjectionQueuedMessagesInput,
  ListProjectionQueuedMessagesInput,
  ProjectionQueuedMessage,
  ProjectionQueuedMessageRepository,
  type ProjectionQueuedMessageRepositoryShape,
} from "../Services/ProjectionQueuedMessages.ts";

const ProjectionQueuedMessageDbRowSchema = ProjectionQueuedMessage.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    composerState: Schema.NullOr(Schema.fromJsonString(OrchestrationQueuedComposerState)),
  }),
);

const makeProjectionQueuedMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionQueuedMessageRow = SqlSchema.void({
    Request: ProjectionQueuedMessage,
    execute: (row) => sql`
      INSERT OR REPLACE INTO projection_queued_messages (
        message_id,
        thread_id,
        text,
        attachments_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        composer_state_json,
        queued_at
      )
      VALUES (
        ${row.messageId},
        ${row.threadId},
        ${row.text},
        ${JSON.stringify(row.attachments)},
        ${row.modelSelection !== null ? JSON.stringify(row.modelSelection) : null},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.sourceProposedPlanThreadId},
        ${row.sourceProposedPlanId},
        ${row.composerState !== null ? JSON.stringify(row.composerState) : null},
        ${row.queuedAt}
      )
    `,
  });

  const listProjectionQueuedMessageRows = SqlSchema.findAll({
    Request: ListProjectionQueuedMessagesInput,
    Result: ProjectionQueuedMessageDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        text,
        attachments_json AS "attachments",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        composer_state_json AS "composerState",
        queued_at AS "queuedAt"
      FROM projection_queued_messages
      WHERE thread_id = ${threadId}
      ORDER BY rowid ASC
    `,
  });

  const deleteProjectionQueuedMessageRow = SqlSchema.void({
    Request: DeleteProjectionQueuedMessageInput,
    execute: ({ threadId, messageId }) => sql`
      DELETE FROM projection_queued_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `,
  });

  const deleteProjectionQueuedMessageRows = SqlSchema.void({
    Request: DeleteProjectionQueuedMessagesInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_queued_messages
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionQueuedMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionQueuedMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueuedMessageRepository.upsert:query")),
    );

  const listByThreadId: ProjectionQueuedMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionQueuedMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionQueuedMessageRepository.listByThreadId:query"),
      ),
    );

  const deleteByMessageId: ProjectionQueuedMessageRepositoryShape["deleteByMessageId"] = (input) =>
    deleteProjectionQueuedMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionQueuedMessageRepository.deleteByMessageId:query"),
      ),
    );

  const deleteByThreadId: ProjectionQueuedMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionQueuedMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionQueuedMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByMessageId,
    deleteByThreadId,
  } satisfies ProjectionQueuedMessageRepositoryShape;
});

export const ProjectionQueuedMessageRepositoryLive = Layer.effect(
  ProjectionQueuedMessageRepository,
  makeProjectionQueuedMessageRepository,
);
