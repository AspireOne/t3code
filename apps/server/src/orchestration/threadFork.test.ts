import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import { selectForkSource, selectThreadForkHistory } from "./threadFork.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";
const SOURCE = ThreadId.make("source");
const turns: ProjectionTurn[] = [1, 2, 3].map((n) => ({
  threadId: SOURCE,
  turnId: TurnId.make(`turn-${n}`),
  pendingMessageId: MessageId.make(`user-${n}`),
  assistantMessageId: MessageId.make(`assistant-${n}`),
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  checkpointTurnCount: n,
  checkpointRef: CheckpointRef.make(`refs/checkpoint/${n}`),
  checkpointStatus: "ready",
  checkpointFiles: [],
  sourceProposedPlanId: null,
  sourceProposedPlanThreadId: null,
}));

const source: OrchestrationThread = {
  id: SOURCE,
  projectId: ProjectId.make("project"),
  title: "Source",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  updatedAt: LATER,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  session: null,
  latestTurn: {
    turnId: TurnId.make("turn-3"),
    state: "completed",
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    assistantMessageId: MessageId.make("assistant-3"),
  },
  queuedMessages: [],
  pendingTurnStart: null,
  messages: [1, 2, 3].flatMap((n) => [
    {
      id: MessageId.make(`user-${n}`),
      role: "user" as const,
      text: `prompt ${n}`,
      turnId: null,
      createdAt: NOW,
      updatedAt: NOW,
      streaming: false,
      attachments: [],
    },
    {
      id: MessageId.make(`assistant-${n}`),
      role: "assistant" as const,
      text: `response ${n}`,
      turnId: TurnId.make(`turn-${n}`),
      createdAt: NOW,
      updatedAt: NOW,
      streaming: false,
      attachments: [],
    },
  ]),
  proposedPlans: [1, 2, 3].map((n) => ({
    id: `plan-${n}` as OrchestrationProposedPlanId,
    turnId: TurnId.make(`turn-${n}`),
    planMarkdown: `plan ${n}`,
    implementedAt: null,
    implementationThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
  })),
  activities: [1, 2, 3].map((n) => ({
    id: EventId.make(`activity-${n}`),
    turnId: TurnId.make(`turn-${n}`),
    tone: "tool",
    kind: "tool.completed",
    summary: `activity ${n}`,
    payload: {},
    createdAt: NOW,
  })),
  checkpoints: [1, 2, 3].map((n) => ({
    turnId: TurnId.make(`turn-${n}`),
    checkpointTurnCount: n,
    checkpointRef: CheckpointRef.make(`refs/checkpoint/${n}`),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(`assistant-${n}`),
    completedAt: NOW,
  })),
};

describe("selected-turn fork history", () => {
  it("includes the selected prompt and response despite tied timestamps and null prompt turn IDs", () => {
    const prepared = selectThreadForkHistory(source, turns, TurnId.make("turn-2"));
    expect(prepared?.latestTurn.turnId).toBe("turn-2");
    expect(prepared?.historySelection).toEqual({
      turnIds: ["turn-1", "turn-2"],
      messageIds: ["user-1", "assistant-1", "user-2", "assistant-2"],
      proposedPlanIds: ["plan-1", "plan-2"],
      activityIds: ["activity-1", "activity-2"],
    });
    const selected = selectForkSource(source, prepared!.historySelection);
    expect(selected.messages.map((message) => message.text)).toEqual([
      "prompt 1",
      "response 1",
      "prompt 2",
      "response 2",
    ]);
    expect(selected.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([
      1, 2,
    ]);
    expect(source.messages).toHaveLength(6);
  });

  it.each([
    ["turn-1", ["user-1", "assistant-1"]],
    ["turn-3", ["user-1", "assistant-1", "user-2", "assistant-2", "user-3", "assistant-3"]],
  ] as const)("forks through %s inclusively", (id, messageIds) => {
    expect(
      selectThreadForkHistory(source, turns, TurnId.make(id))?.historySelection.messageIds,
    ).toEqual(messageIds);
  });

  it.each(["running", "pending"] as const)(
    "rejects a %s turn even with an intermediate checkpoint",
    (state) => {
      expect(
        selectThreadForkHistory(source, [{ ...turns[0]!, state }], TurnId.make("turn-1")),
      ).toBeNull();
    },
  );

  it("rejects missing, reverted, and unfinished turns", () => {
    expect(selectThreadForkHistory(source, turns, TurnId.make("unknown"))).toBeNull();
    expect(selectThreadForkHistory(source, turns.slice(0, 1), TurnId.make("turn-2"))).toBeNull();
    expect(
      selectThreadForkHistory(source, [{ ...turns[0]!, completedAt: null }], TurnId.make("turn-1")),
    ).toBeNull();
  });

  it("preserves imported context and excludes later turnless records", () => {
    const before = {
      ...source.messages[0]!,
      id: MessageId.make("import:context"),
      role: "system" as const,
    };
    const after = { ...before, id: MessageId.make("later-system"), createdAt: LATER };
    const prepared = selectThreadForkHistory(
      {
        ...source,
        messages: [before, ...source.messages, after],
        activities: [
          ...source.activities,
          {
            ...source.activities[0]!,
            id: EventId.make("later-activity"),
            turnId: null,
            createdAt: LATER,
          },
        ],
      },
      turns,
      TurnId.make("turn-1"),
    );
    expect(prepared?.historySelection.messageIds).toEqual([
      "import:context",
      "user-1",
      "assistant-1",
    ]);
    expect(prepared?.historySelection.activityIds).toEqual(["activity-1"]);
  });

  it("uses native turn chronology when checkpoints are unavailable", () => {
    const historical = turns.map((turn, index) => ({
      ...turn,
      checkpointTurnCount: null,
      requestedAt: `2026-01-01T00:00:0${index}.000Z`,
      completedAt: `2026-01-01T00:00:0${index}.500Z`,
    }));
    expect(
      selectThreadForkHistory(source, historical, TurnId.make("turn-2"))?.historySelection.turnIds,
    ).toEqual(["turn-1", "turn-2"]);
  });

  it("preserves an interrupted or failed turn's actual lifecycle", () => {
    for (const state of ["interrupted", "error"] as const) {
      expect(
        selectThreadForkHistory(source, [{ ...turns[0]!, state }], TurnId.make("turn-1"))
          ?.latestTurn.state,
      ).toBe(state);
    }
  });
});
