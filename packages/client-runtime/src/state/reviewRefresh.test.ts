import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { REVIEW_DIFF_REFRESH_INTERVAL_MS, startReviewDiffRefresh } from "./reviewRefresh.ts";

afterEach(() => vi.useRealTimers());

describe("visible workspace diff refresh", () => {
  it("updates an open diff after an external edit, commit, or another thread's edit", () => {
    vi.useFakeTimers();
    let workspacePatch = "original";
    let displayedPatch = workspacePatch;
    const refresh = startReviewDiffRefresh({
      active: true,
      isPending: () => false,
      refresh: () => {
        displayedPatch = workspacePatch;
      },
    });
    for (const patch of ["external edit", "", "another thread's edit"]) {
      workspacePatch = patch;
      vi.advanceTimersByTime(REVIEW_DIFF_REFRESH_INTERVAL_MS);
      expect(displayedPatch).toBe(patch);
    }
    refresh.dispose();
  });

  it("pauses when hidden, refreshes once on return, and stops after closing", () => {
    vi.useFakeTimers();
    const request = vi.fn();
    const refresh = startReviewDiffRefresh({
      active: true,
      isPending: () => false,
      refresh: request,
    });
    expect(request).not.toHaveBeenCalled();
    refresh.setActive(false);
    vi.advanceTimersByTime(REVIEW_DIFF_REFRESH_INTERVAL_MS * 100);
    expect(request).not.toHaveBeenCalled();
    refresh.setActive(true);
    refresh.requestRefresh();
    expect(request).toHaveBeenCalledTimes(1);
    refresh.dispose();
    vi.advanceTimersByTime(REVIEW_DIFF_REFRESH_INTERVAL_MS * 100);
    refresh.setActive(false);
    refresh.setActive(true);
    refresh.requestRefresh();
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a slow request finish and resumes refreshing afterward", () => {
    vi.useFakeTimers();
    let pending = true;
    const request = vi.fn();
    const refresh = startReviewDiffRefresh({
      active: true,
      isPending: () => pending,
      refresh: request,
    });
    vi.advanceTimersByTime(REVIEW_DIFF_REFRESH_INTERVAL_MS * 3);
    refresh.requestRefresh();
    expect(request).not.toHaveBeenCalled();
    pending = false;
    vi.advanceTimersByTime(REVIEW_DIFF_REFRESH_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(1);
    refresh.dispose();
  });
});
