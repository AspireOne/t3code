import { memo, useState } from "react";
import { CornerDownLeftIcon, ListEndIcon, Trash2Icon } from "lucide-react";

import type { MessageId, OrchestrationQueuedMessage } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

type QueueAction = "move" | "remove";

function queuedMessageLabel(message: OrchestrationQueuedMessage): string {
  const composerState = message.composerState;
  if (composerState) {
    const previewText = composerState.previewText.trim();
    if (previewText) return previewText;

    const contextCount =
      composerState.terminalContexts.length +
      composerState.elementContexts.length +
      composerState.previewAnnotations.length +
      composerState.reviewComments.length;
    if (contextCount > 0) {
      return `${contextCount} attached context${contextCount === 1 ? "" : "s"}`;
    }
    if (message.attachments.length > 0) {
      return `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
    }
    return "Empty message";
  }

  const visibleText = deriveDisplayedUserMessageState(message.text).visibleText.trim();
  if (visibleText) return visibleText;
  if (message.attachments.length > 0) {
    return `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`;
  }
  return "Empty message";
}

/** Messages held for the next natural turn boundary. */
export const QueuedMessageList = memo(function QueuedMessageList(props: {
  readonly queuedMessages: ReadonlyArray<OrchestrationQueuedMessage>;
  readonly disabled?: boolean;
  readonly onMoveToInput: (message: OrchestrationQueuedMessage) => void | Promise<void>;
  readonly onRemove: (messageId: MessageId) => void | Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<{
    messageId: MessageId;
    action: QueueAction;
  } | null>(null);

  const runAction = async (
    messageId: MessageId,
    action: QueueAction,
    callback: () => void | Promise<void>,
  ) => {
    if (props.disabled || busyAction !== null) return;
    setBusyAction({ messageId, action });
    try {
      await callback();
    } finally {
      setBusyAction(null);
    }
  };

  if (props.queuedMessages.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1" data-chat-queued-messages="true">
      {props.queuedMessages.map((message, index) => {
        const isMoving = busyAction?.messageId === message.messageId;
        const label = queuedMessageLabel(message);
        return (
          <div
            key={message.messageId}
            className="flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-card/95 py-1.5 pr-1.5 pl-3 shadow-sm backdrop-blur"
          >
            <ListEndIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                <span>Queued {index + 1}</span>
                {message.attachments.length > 0 ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {message.attachments.length} attachment
                      {message.attachments.length === 1 ? "" : "s"}
                    </span>
                  </>
                ) : null}
              </div>
              <span className="block truncate text-sm text-foreground/90" title={label}>
                {label}
              </span>
            </div>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={props.disabled || busyAction !== null}
              aria-label="Move queued message back to input"
              title="Move back to input"
              onClick={() =>
                void runAction(message.messageId, "move", () => props.onMoveToInput(message))
              }
            >
              {isMoving && busyAction?.action === "move" ? (
                <Spinner className="size-3.5" />
              ) : (
                <CornerDownLeftIcon className="size-3.5" />
              )}
              <span className="hidden sm:inline">Move to input</span>
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={props.disabled || busyAction !== null}
              aria-label="Remove queued message"
              title="Remove queued message"
              onClick={() =>
                void runAction(message.messageId, "remove", () => props.onRemove(message.messageId))
              }
            >
              {isMoving && busyAction?.action === "remove" ? (
                <Spinner className="size-3.5" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
});
