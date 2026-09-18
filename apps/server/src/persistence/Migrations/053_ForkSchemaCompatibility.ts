import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import clearAutomaticModelDefaults from "./044_ClearAutomaticProjectModelDefaults.ts";
import addSessionStartedAt from "./044_ProjectionThreadSessionStartedAt.ts";
import addProjectsAutoPull from "./045_ProjectionProjectsAutoPull.ts";
import addQueuedMessages from "./045_ProjectionQueuedMessages.ts";
import addThreadPullRequests from "./050_ProjectionThreadPullRequests.ts";

// Fork releases recorded their own migrations under IDs 44/45 and this
// compatibility migration under ID 50, so upgrading fork databases skipped
// upstream's 44/45/50 carrying the same IDs. Re-run upstream's skipped
// effects conditionally and the fork schema additions unconditionally,
// all idempotent, so both histories converge on the same schema.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessionHistory = yield* sql<{ readonly name: string }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = 44
  `;
  if (sessionHistory[0]?.name === "ProjectionThreadSessionStartedAt") {
    yield* clearAutomaticModelDefaults;
  }
  const pullRequestHistory = yield* sql<{ readonly name: string }>`
    SELECT name FROM effect_sql_migrations WHERE migration_id = 50
  `;
  if (pullRequestHistory[0]?.name === "ForkSchemaCompatibility") {
    yield* addThreadPullRequests;
  }
  yield* addProjectsAutoPull;
  yield* addSessionStartedAt;
  yield* addQueuedMessages;
});
