import type { ScopedThreadRef } from "@t3tools/contracts";

const THREAD_RENAME_REQUEST_EVENT = "t3code:request-thread-rename";
// The mobile sidebar is mounted lazily inside its sheet. Keep the latest
// request until a sidebar consumer confirms that it handled the target.
let pendingThreadRenameRequest: ScopedThreadRef | null = null;
let activeRequestHandled = false;

export function requestThreadRename(threadRef: ScopedThreadRef): void {
  pendingThreadRenameRequest = threadRef;
  activeRequestHandled = false;
  window.dispatchEvent(
    new CustomEvent<ScopedThreadRef>(THREAD_RENAME_REQUEST_EVENT, { detail: threadRef }),
  );
  if (activeRequestHandled) {
    pendingThreadRenameRequest = null;
  }
}

/**
 * Return true only when this consumer owns the requested thread. Returning
 * false lets another project row consume a pending request.
 */
export function onThreadRenameRequest(
  listener: (threadRef: ScopedThreadRef) => boolean,
): () => void {
  const handler = (event: Event) => {
    if (listener((event as CustomEvent<ScopedThreadRef>).detail)) {
      activeRequestHandled = true;
    }
  };
  window.addEventListener(THREAD_RENAME_REQUEST_EVENT, handler);
  if (pendingThreadRenameRequest !== null && listener(pendingThreadRenameRequest)) {
    pendingThreadRenameRequest = null;
  }
  return () => window.removeEventListener(THREAD_RENAME_REQUEST_EVENT, handler);
}
