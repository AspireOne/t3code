import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.addToast },
}));

import { showUpstreamReleaseToast } from "./UpstreamReleaseNotification";

describe("upstream release notification", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  it("explains the manual fork workflow and links the exact release", () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    showUpstreamReleaseToast(
      { openExternal },
      {
        currentVersion: "0.0.35",
        latestVersion: "0.0.36",
        releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36",
        updateAvailable: true,
      },
    );

    const toast = testState.addToast.mock.calls[0]?.[0];
    expect(toast).toMatchObject({
      type: "info",
      title: "Upstream T3 Code 0.0.36 is available",
      description:
        "This fork is built from 0.0.35. Sync it with upstream, rebuild, and reinstall to update.",
      timeout: 0,
      actionProps: { children: "View release" },
    });

    toast.actionProps.onClick();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36",
    );
  });
});
