import {
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

type CodexCompactionSubmissionDetails = {
  readonly id: MessageId;
  readonly command: string;
  readonly createdAt: string;
};

export type CodexCompactionSubmission = CodexCompactionSubmissionDetails &
  (
    | { readonly status: "compacting" }
    | { readonly status: "failed"; readonly errorMessage: string }
  );

export function hasCodexCompactionTerminalActivity(
  submission: CodexCompactionSubmissionDetails,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  return activities.some(
    (activity) =>
      activity.createdAt >= submission.createdAt &&
      (activity.kind === "context-compaction" ||
        activity.kind === "provider.context-compaction.failed"),
  );
}

export function codexCompactionMessage(
  submission: CodexCompactionSubmission,
  role: "user" | "assistant" = "user",
): OrchestrationMessage {
  const text =
    role === "user"
      ? submission.command
      : submission.status === "failed"
        ? `Could not compact context.\n\n${submission.errorMessage}`
        : "Compacting context...";

  return {
    id: role === "user" ? submission.id : MessageId.make(`${submission.id}:compaction`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
  };
}
