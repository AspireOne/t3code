import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  isProviderSendTurnSupportedImageMimeType,
  type AssetCreateUrlResult,
  type ChatAttachment,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationQueuedMessage,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  persistComposerAttachmentFile,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "../lib/composerImages";
import type { DraftComposerAttachment, DraftComposerImageAttachment } from "../lib/composerImages";
import { estimateBase64ByteSize } from "../lib/base64";
import { uuidv4 } from "../lib/uuid";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { assetEnvironment } from "./assets";
import { usePreparedConnection } from "./session";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments);
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

function queuedAttachmentFileName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1)?.trim();
  return basename && basename !== "." && basename !== ".." ? basename : "attachment";
}

async function restoreQueuedAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly resource: {
        readonly _tag: "attachment";
        readonly attachmentId: string;
        readonly fileName: string;
        readonly mimeType: string;
      };
    };
  }) => Promise<
    | { readonly _tag: "Success"; readonly value: AssetCreateUrlResult }
    | { readonly _tag: "Failure"; readonly cause: unknown }
  >;
}): Promise<ReadonlyArray<DraftComposerAttachment>> {
  if (input.attachments.length === 0) {
    return [];
  }

  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, `t3-queued-restore-${uuidv4()}`);
  directory.create({ idempotent: true, intermediates: true });
  const persistedFileUris: string[] = [];
  const restored: Array<DraftComposerAttachment> = [];
  try {
    for (const attachment of input.attachments) {
      const assetResult = await input.createAssetUrl({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (assetResult._tag === "Failure") {
        throw assetResult.cause;
      }
      const url = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
      if (url === null) {
        throw new Error(`Could not restore '${attachment.name}'.`);
      }
      const downloaded = new File(directory, uuidv4());
      await File.downloadFileAsync(url, downloaded);
      if (!downloaded.exists) {
        throw new Error(`Could not restore '${attachment.name}'.`);
      }

      if (
        attachment.type === "image" &&
        isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
      ) {
        const base64 = await downloaded.base64();
        const sizeBytes = estimateBase64ByteSize(base64);
        if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          throw new Error(`'${attachment.name}' exceeds the image attachment limit.`);
        }
        const mimeType =
          attachment.mimeType.toLowerCase() as import("@t3tools/contracts").UploadChatImageAttachment["mimeType"];
        const dataUrl = `data:${mimeType};base64,${base64}`;
        restored.push({
          id: uuidv4(),
          type: "image",
          name: attachment.name,
          mimeType,
          sizeBytes,
          dataUrl,
          previewUri: dataUrl,
        });
      } else {
        const fileUri = await persistComposerAttachmentFile(
          downloaded.uri,
          queuedAttachmentFileName(attachment.name),
          PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        );
        persistedFileUris.push(fileUri);
        const sizeBytes = new File(fileUri).size ?? attachment.sizeBytes;
        restored.push({
          id: uuidv4(),
          type: "file",
          name: queuedAttachmentFileName(attachment.name),
          mimeType: attachment.mimeType,
          sizeBytes,
          fileUri,
        });
      }
      if (downloaded.exists) {
        downloaded.delete();
      }
    }
    return restored;
  } catch (error) {
    await Promise.all(
      persistedFileUris.map((fileUri) => removePersistedComposerAttachmentFile(fileUri)),
    );
    throw error;
  } finally {
    if (directory.exists) {
      directory.delete();
    }
  }
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const removeQueuedThreadMessage = useAtomCommand(threadEnvironment.removeQueuedMessage, {
    reportFailure: false,
  });
  const createQueuedAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(selectedThreadShell?.environmentId ?? null);

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return buildThreadFeed(selectedThreadDetail, {
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    });
  }, [feedbackSubmissionsByThreadKey, selectedThreadDetail, selectedThreadKey]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThreadServerQueuedMessages = selectedThreadDetail?.queuedMessages ?? [];
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const enqueueMessage = useCallback(
    async (deliveryMode: "start" | "queue") => {
      if (!selectedThreadShell) {
        return null;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const draft = getComposerDraftSnapshot(threadKey);
      const thread = selectedThreadDetail ?? selectedThreadShell;
      if (
        deliveryMode === "queue" &&
        thread.session?.status !== "starting" &&
        thread.session?.status !== "running"
      ) {
        Alert.alert("Agent is not running", "Queueing is available while the agent is working.");
        return null;
      }
      const text = draft.text.trim();
      const attachments = draft.attachments;
      if (
        composerAttachmentUploadBlockReason({
          environmentId: selectedThreadShell.environmentId,
          attachments,
          connected: selectedEnvironmentRuntime?.connectionState === "connected",
          serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
          states: appAtomRegistry.get(composerAttachmentUploadsAtom),
        }) !== null
      )
        return null;
      if (text.length === 0 && attachments.length === 0) {
        return null;
      }
      // A send-failure restore appends with allowOverflow so it never drops the
      // user's files, which can leave the draft over the cap. Sending it anyway
      // would enqueue a message that outbox recovery rejects forever, so block
      // here until the user removes attachments.
      if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        Alert.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return null;
      }

      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (entry) => entry.instanceId === thread.modelSelection.instanceId,
      );
      const feedbackCommand =
        attachments.length === 0 &&
        (provider?.driver === "codex" || thread.session?.providerName === "codex")
          ? parseCodexFeedbackCommand(text)
          : null;
      if (feedbackCommand) {
        if (deliveryMode === "queue") {
          Alert.alert(
            "Feedback cannot be queued",
            "Submit feedback after the current turn finishes.",
          );
          return null;
        }
        if (thread.session === null) {
          Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
          return null;
        }
        const metadata = makeQueuedMessageMetadata();
        const result = await submitCodexFeedback({
          submission: {
            id: MessageId.make(metadata.messageId),
            command: text,
            createdAt: metadata.createdAt,
          },
          clearDraft: () => clearComposerDraftContent(threadKey),
          onUpdate: (submission) => {
            setFeedbackSubmissionsByThreadKey((current) => {
              const existing = current[threadKey] ?? [];
              const found = existing.some((entry) => entry.id === submission.id);
              return {
                ...current,
                [threadKey]: found
                  ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                  : [...existing, submission],
              };
            });
          },
          upload: () =>
            uploadThreadFeedback({
              environmentId: selectedThreadShell.environmentId,
              input: {
                threadId: selectedThreadShell.id,
                ...feedbackCommand,
              },
            }),
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            return null;
          }
          const error = Cause.squash(result.cause);
          Alert.alert(
            "Could not send feedback to OpenAI",
            error instanceof Error ? error.message : "An error occurred.",
          );
          return null;
        }
        const feedbackId = result.value.feedbackId;
        Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
          { text: "OK", style: "cancel" },
          {
            text: "Copy ID",
            onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
          },
        ]);
        return null;
      }

      const metadata = makeQueuedMessageMetadata();
      const messageId = MessageId.make(metadata.messageId);
      // Enqueue publishes the queued atom synchronously (the durable write
      // happens behind it), so clearing the draft here gives send feedback on
      // the tap frame instead of after file I/O. If the write fails the message
      // is rolled out of the queue and the content is merged back into the
      // draft, preserving anything typed since.
      const enqueuePromise = enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        modelSelection: draft.modelSelection ?? thread.modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: draft.interactionMode ?? thread.interactionMode,
        ...(deliveryMode === "queue" ? { deliveryMode } : {}),
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
      enqueuePromise.then(
        () => {
          // The queued message owns the files now; the sweep sees that and
          // spares them. Deferred to here so a failed write cannot roll the
          // message out of the queue mid-sweep and lose the bytes.
          scheduleUnusedComposerAttachmentCleanup(attachments);
        },
        (error: unknown) => {
          // Restore text via merge (idempotent) but attachments via the uncapped
          // append: the merge path slots existing attachments first and truncates
          // at the send limit, which would silently drop this message's images if
          // the user attached new ones while the write was in flight.
          void mergeComposerDraftContent(threadKey, { text, attachments: [] });
          appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
          setPendingConnectionError(
            error instanceof Error ? error.message : "Failed to save the queued message.",
          );
        },
      );
      return messageId;
    },
    [
      selectedEnvironmentRuntime?.connectionState,
      selectedEnvironmentRuntime?.serverConfig,
      selectedThreadDetail,
      selectedThreadShell,
      uploadThreadFeedback,
    ],
  );

  const onSendMessage = useCallback(() => enqueueMessage("start"), [enqueueMessage]);
  const onQueueMessage = useCallback(() => enqueueMessage("queue"), [enqueueMessage]);

  const onRemoveQueuedMessage = useCallback(
    async (messageId: MessageId) => {
      if (!selectedThreadShell) {
        return;
      }
      const result = await removeQueuedThreadMessage({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          messageId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not remove queued message",
          error instanceof Error ? error.message : "The queued message is still pending.",
        );
      }
    },
    [removeQueuedThreadMessage, selectedThreadShell],
  );

  const onMoveQueuedMessage = useCallback(
    async (queuedMessage: OrchestrationQueuedMessage) => {
      if (!selectedThreadShell) {
        return;
      }
      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const currentDraft = getComposerDraftSnapshot(threadKey);
      if (
        currentDraft.attachments.length + queuedMessage.attachments.length >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        Alert.alert(
          "Too many attachments",
          `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
        );
        return;
      }
      if (preparedConnection._tag === "None") {
        Alert.alert("Could not restore message", "Reconnect to restore its attachments.");
        return;
      }

      let restoredAttachments: ReadonlyArray<DraftComposerAttachment>;
      try {
        restoredAttachments = await restoreQueuedAttachments({
          environmentId: selectedThreadShell.environmentId,
          httpBaseUrl: preparedConnection.value.httpBaseUrl,
          attachments: queuedMessage.attachments,
          createAssetUrl: createQueuedAttachmentAssetUrl,
        });
      } catch (error) {
        Alert.alert(
          "Could not restore message",
          error instanceof Error ? error.message : "The queued message is still pending.",
        );
        return;
      }

      const removal = await removeQueuedThreadMessage({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          messageId: queuedMessage.messageId,
        },
      });
      if (removal._tag === "Failure") {
        await Promise.all(
          restoredAttachments
            .filter(
              (attachment): attachment is Extract<DraftComposerAttachment, { type: "file" }> =>
                attachment.type === "file",
            )
            .map((attachment) => removePersistedComposerAttachmentFile(attachment.fileUri)),
        );
        if (!isAtomCommandInterrupted(removal)) {
          const error = Cause.squash(removal.cause);
          Alert.alert(
            "Could not move queued message",
            error instanceof Error ? error.message : "The queued message is still pending.",
          );
        }
        return;
      }

      updateComposerDraftSettings(threadKey, {
        ...(queuedMessage.modelSelection !== undefined
          ? { modelSelection: queuedMessage.modelSelection }
          : {}),
        runtimeMode: queuedMessage.runtimeMode,
        interactionMode: queuedMessage.interactionMode,
      });
      try {
        await mergeComposerDraftContent(threadKey, {
          text: queuedMessage.composerState?.previewText ?? queuedMessage.text,
          attachments: restoredAttachments,
        });
      } catch (error) {
        Alert.alert(
          "Message restored",
          error instanceof Error
            ? error.message
            : "The message is back in the input, but could not be saved yet.",
        );
      }
    },
    [
      createQueuedAttachmentAssetUrl,
      preparedConnection,
      removeQueuedThreadMessage,
      selectedThreadShell,
    ],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments);
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files);
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images);
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadServerQueuedMessages,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onQueueMessage,
    onMoveQueuedMessage,
    onRemoveQueuedMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
