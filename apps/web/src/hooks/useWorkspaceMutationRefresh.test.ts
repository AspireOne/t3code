import { EnvironmentId, EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  latestWorkspaceMutationId,
  useWorkspaceMutationVcsStatusRefresh,
  workspaceMutationRefreshToken,
} from "./useWorkspaceMutationRefresh";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function activity(
  id: string,
  kind: string,
  itemType: string,
  status?: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    summary: "Tool activity",
    payload: { itemType, ...(status ? { status } : {}) },
    turnId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("workspace mutation refresh", () => {
  it("tracks the latest completed file change or command", () => {
    expect(
      latestWorkspaceMutationId([
        activity("file-started", "tool.started", "file_change"),
        activity("search-completed", "tool.completed", "web_search"),
        activity("file-completed", "tool.completed", "file_change"),
        activity("command-completed", "tool.completed", "command_execution"),
      ]),
    ).toBe("command-completed");
  });

  it("ignores read-only and in-progress tools", () => {
    expect(
      latestWorkspaceMutationId([
        activity("command-updated", "tool.updated", "command_execution", "inProgress"),
        activity("legacy-command-updated", "tool.updated", "command_execution", "in_progress"),
        activity("image-completed", "tool.completed", "image_view"),
      ]),
    ).toBeNull();
  });

  it("accepts providers that report terminal state on an update", () => {
    expect(
      latestWorkspaceMutationId([
        activity("file-updated", "tool.updated", "file_change", "completed"),
      ]),
    ).toBe("file-updated");
  });

  it("scopes the same mutation to each preview resource", () => {
    expect(workspaceMutationRefreshToken("file:/repo/README.md", "event-1")).not.toBe(
      workspaceMutationRefreshToken("diff:/repo", "event-1"),
    );
    expect(workspaceMutationRefreshToken("file:/repo/README.md", null)).toBeNull();
  });

  it("rescans Git status once for each completed workspace mutation", async () => {
    const refreshStatus = vi.fn();
    const environmentId = EnvironmentId.make("environment-1");
    let renderer: ReactTestRenderer | undefined;
    const Probe = ({ mutationId }: { readonly mutationId: string | null }) => {
      useWorkspaceMutationVcsStatusRefresh({
        environmentId,
        cwd: "/repo",
        mutationId,
        refreshStatus,
        resourceKey: "git-status:thread-1:/repo",
      });
      return null;
    };

    await act(() => {
      renderer = create(createElement(Probe, { mutationId: null }));
    });
    await act(() => renderer?.update(createElement(Probe, { mutationId: "event-1" })));
    await act(() => renderer?.update(createElement(Probe, { mutationId: "event-1" })));
    await act(() => renderer?.update(createElement(Probe, { mutationId: "event-2" })));

    expect(refreshStatus.mock.calls).toEqual([
      [{ environmentId, input: { cwd: "/repo" } }],
      [{ environmentId, input: { cwd: "/repo" } }],
    ]);

    await act(() => renderer?.unmount());
  });
});
