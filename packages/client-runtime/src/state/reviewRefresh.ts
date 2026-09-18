// @effect-diagnostics globalDate:off globalTimers:off -- React owns this view timer and disposes it on unmount.
export const REVIEW_DIFF_REFRESH_INTERVAL_MS = 5_000;
const MIN_REFRESH_INTERVAL_MS = 1_000;

/** Keeps an open workspace diff fresh without interrupting slow requests. */
export function startReviewDiffRefresh(input: {
  readonly active: boolean;
  readonly refresh: () => void;
  readonly isPending: () => boolean;
}) {
  let active = input.active;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRequestedAt = -Infinity;

  const requestRefresh = () => {
    if (!active || disposed || input.isPending()) return;
    const now = Date.now();
    if (now - lastRequestedAt < MIN_REFRESH_INTERVAL_MS) return;
    lastRequestedAt = now;
    input.refresh();
  };
  const arm = () => {
    clearTimeout(timer);
    if (!active || disposed) return;
    timer = setTimeout(() => {
      requestRefresh();
      arm();
    }, REVIEW_DIFF_REFRESH_INTERVAL_MS);
  };
  arm();
  return {
    requestRefresh,
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      if (active) requestRefresh();
      arm();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
