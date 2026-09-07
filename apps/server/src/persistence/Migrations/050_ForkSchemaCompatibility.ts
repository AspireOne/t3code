import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import clearAutomaticModelDefaults from "./044_ClearAutomaticProjectModelDefaults.ts";
import addSessionStartedAt from "./044_ProjectionThreadSessionStartedAt.ts";
import addProjectsAutoPull from "./045_ProjectionProjectsAutoPull.ts";
import addQueuedMessages from "./045_ProjectionQueuedMessages.ts";

// Fork versions before v39 used IDs 44/45 for session timestamps and queues.
// The migrator advances by ID, so those databases skip upstream's 44/45.
// Keep this ID/name compatible with already-installed v39 fork builds.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const history = yield* sql<{ readonly name: string }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = 44
  `;
  if (history[0]?.name === "ProjectionThreadSessionStartedAt") {
    yield* clearAutomaticModelDefaults;
  }
  yield* addProjectsAutoPull;
  yield* addSessionStartedAt;
  yield* addQueuedMessages;
});
