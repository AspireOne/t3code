import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { onThreadRenameRequest, requestThreadRename } from "./threadRenameBus";

describe("threadRenameBus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the scoped thread reference and supports unsubscribe", () => {
    vi.stubGlobal("window", new EventTarget());
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-1"),
    );
    const listener = vi.fn(() => true);
    const unsubscribe = onThreadRenameRequest(listener);

    requestThreadRename(threadRef);
    expect(listener).toHaveBeenCalledWith(threadRef);

    unsubscribe();
    requestThreadRename(threadRef);
    expect(listener).toHaveBeenCalledTimes(1);

    const lateListener = vi.fn(() => true);
    const unsubscribeLateListener = onThreadRenameRequest(lateListener);
    expect(lateListener).toHaveBeenCalledWith(threadRef);
    unsubscribeLateListener();
  });

  it("keeps an unhandled request until a matching consumer mounts", () => {
    vi.stubGlobal("window", new EventTarget());
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-local"),
      ThreadId.make("thread-2"),
    );
    const ignoredListener = vi.fn(() => false);
    const matchingListener = vi.fn(() => true);
    const unsubscribeIgnored = onThreadRenameRequest(ignoredListener);

    requestThreadRename(threadRef);
    expect(ignoredListener).toHaveBeenCalledWith(threadRef);

    const unsubscribeMatching = onThreadRenameRequest(matchingListener);
    expect(matchingListener).toHaveBeenCalledWith(threadRef);

    unsubscribeIgnored();
    unsubscribeMatching();
  });
});
