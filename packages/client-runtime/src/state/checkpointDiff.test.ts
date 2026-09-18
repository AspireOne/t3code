import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildCheckpointDiffTargets } from "./checkpointDiff.ts";

describe("checkpoint diff targets", () => {
  it.each([
    { fromTurnCount: 0, expectedKind: "fullThread" as const },
    { fromTurnCount: 3, expectedKind: "turn" as const },
  ])("keys a $expectedKind query by turn identity without sending it", (input) => {
    const targets = buildCheckpointDiffTargets({
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
      fromTurnCount: input.fromTurnCount,
      toTurnCount: 4,
      ignoreWhitespace: false,
      cacheScope: "replacement-turn-id",
    });
    const target = targets[input.expectedKind];

    expect(target?.cacheScope).toBe("replacement-turn-id");
    expect(target?.input).not.toHaveProperty("cacheScope");
  });
});
