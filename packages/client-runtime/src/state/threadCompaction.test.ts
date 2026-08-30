import { EventId, MessageId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexCompactionMessage,
  hasCodexCompactionTerminalActivity,
  type CodexCompactionSubmission,
} from "./threadCompaction.ts";

const submission = {
  id: MessageId.make("compact-command"),
  command: "/compact",
  createdAt: "2026-08-31T12:00:00.000Z",
  status: "compacting",
} satisfies CodexCompactionSubmission;

describe("codexCompactionMessage", () => {
  it("renders the command and in-flight status as a local exchange", () => {
    expect(codexCompactionMessage(submission).text).toBe("/compact");
    expect(codexCompactionMessage(submission, "assistant").text).toBe("Compacting context...");
  });

  it("renders a direct command failure", () => {
    const failed = {
      ...submission,
      status: "failed",
      errorMessage: "The provider session is unavailable.",
    } satisfies CodexCompactionSubmission;

    expect(codexCompactionMessage(failed, "assistant").text).toBe(
      "Could not compact context.\n\nThe provider session is unavailable.",
    );
  });
});

describe("hasCodexCompactionTerminalActivity", () => {
  const activity = (
    kind: "context-compaction" | "provider.context-compaction.failed",
    createdAt = submission.createdAt,
  ) =>
    ({
      id: EventId.make(`activity-${kind}`),
      kind,
      createdAt,
      tone: kind === "context-compaction" ? "info" : "error",
      summary: kind === "context-compaction" ? "Context compacted" : "Compaction failed",
      payload: {},
      turnId: null,
    }) satisfies OrchestrationThreadActivity;

  it("recognizes successful and failed terminal activities for the request", () => {
    expect(hasCodexCompactionTerminalActivity(submission, [activity("context-compaction")])).toBe(
      true,
    );
    expect(
      hasCodexCompactionTerminalActivity(submission, [
        activity("provider.context-compaction.failed"),
      ]),
    ).toBe(true);
  });

  it("ignores a terminal activity from an older request", () => {
    expect(
      hasCodexCompactionTerminalActivity(submission, [
        activity("context-compaction", "2026-08-31T11:59:59.999Z"),
      ]),
    ).toBe(false);
  });
});
