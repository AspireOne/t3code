import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import addSessionStartedAt from "./044_ProjectionThreadSessionStartedAt.ts";
import addQueuedMessages from "./045_ProjectionQueuedMessages.ts";
import reconcileFork from "./050_ForkSchemaCompatibility.ts";

for (const history of ["fresh", "upstream", "fork"] as const) {
  it.layer(NodeSqliteClient.layerMemory())(`v39 migration from ${history}`, (it) => {
    it.effect("preserves existing queue data and converges both schema histories", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 43 });
        const model = '{"instanceId":"codex","model":"gpt-5.4"}';
        for (const projectId of ["automatic", "configured"]) {
          yield* sql`
            INSERT INTO projection_projects
              (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
            VALUES (${projectId}, ${projectId}, '/tmp/project', ${model}, '[]', '2026-01-01', '2026-01-01')
          `;
          yield* sql`
            INSERT INTO orchestration_events
              (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
            VALUES (${projectId}, 'project', ${projectId}, 1, 'project.created', '2026-01-01', 'user',
              json_object('defaultModelSelection', json(${model})), '{}')
          `;
        }
        yield* sql`
          INSERT INTO orchestration_events
            (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES ('configured-update', 'project', 'configured', 2, 'project.meta-updated', '2026-01-01', 'user',
            json_object('defaultModelSelection', json(${model})), '{}')
        `;
        if (history === "upstream") yield* runMigrations({ toMigrationInclusive: 49 });
        if (history === "fork") {
          yield* addSessionStartedAt;
          yield* addQueuedMessages;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (44, 'ProjectionThreadSessionStartedAt'), (45, 'ProjectionQueuedMessages')
          `;
          yield* sql`
            INSERT INTO projection_queued_messages
              (message_id, thread_id, text, attachments_json, runtime_mode, interaction_mode, queued_at)
            VALUES ('queued-1', 'thread-1', 'Keep this follow-up', '[]', 'full-access', 'default', '2026-01-01T00:00:00.000Z')
          `;
        }
        yield* runMigrations();
        yield* sql`UPDATE projection_projects SET auto_pull = 1`;
        yield* reconcileFork;
        assert.deepEqual(yield* runMigrations(), []);
        const projectColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_projects)`;
        const sessionColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_thread_sessions)`;
        assert.isTrue(projectColumns.some((column) => column.name === "auto_pull"));
        assert.isTrue(sessionColumns.some((column) => column.name === "started_at"));
        const projects = yield* sql<{
          readonly projectId: string;
          readonly model: string | null;
          readonly autoPull: number;
        }>`
          SELECT project_id AS "projectId", default_model_selection_json AS model, auto_pull AS "autoPull"
          FROM projection_projects ORDER BY project_id
        `;
        assert.deepEqual(projects, [
          { projectId: "automatic", model: null, autoPull: 1 },
          { projectId: "configured", model, autoPull: 1 },
        ]);
        const queue = yield* sql<{
          readonly text: string;
        }>`SELECT text FROM projection_queued_messages`;
        assert.deepEqual(queue, history === "fork" ? [{ text: "Keep this follow-up" }] : []);
      }),
    );
  });
}
