import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type OrchestrationSession,
  type ScopedThreadRef,
  type ServerProviderRateLimits,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerCodexUsage = {
  rateLimits: ServerProviderRateLimits | null;
  accountEmail: string | null;
};

function normalizeAccountEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

/** Resolve the account-bound Codex usage shown by the composer. */
export function resolveComposerCodexUsage(input: {
  provider: ProviderDriverKind;
  session: OrchestrationSession | null;
  sessionRateLimits: ServerProviderRateLimits | null;
  sessionRateLimitsError?: string | null | undefined;
  providerRateLimits: ServerProviderRateLimits | null;
  providerEmail?: string | null | undefined;
}): ComposerCodexUsage {
  if (input.provider !== "codex") {
    return { rateLimits: null, accountEmail: null };
  }

  const session = input.session;
  if (session === null) {
    return {
      rateLimits: input.providerRateLimits,
      accountEmail: normalizeAccountEmail(input.providerEmail),
    };
  }
  const status = session.status;
  if (status === "idle" || status === "stopped") {
    return {
      rateLimits: input.providerRateLimits,
      accountEmail: normalizeAccountEmail(input.providerEmail),
    };
  }
  if (status !== "ready" && status !== "running") {
    return { rateLimits: null, accountEmail: null };
  }
  // The query keeps its previous success value while a refresh fails. Never
  // present that cached snapshot as the current session's account or quota.
  if (input.sessionRateLimitsError !== undefined && input.sessionRateLimitsError !== null) {
    return { rateLimits: null, accountEmail: null };
  }

  const fetchedAt = Date.parse(input.sessionRateLimits?.fetchedAt ?? "");
  const sessionStartedAt = Date.parse(session.startedAt ?? session.updatedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= sessionStartedAt) {
    return { rateLimits: null, accountEmail: null };
  }

  return {
    rateLimits: input.sessionRateLimits,
    accountEmail: normalizeAccountEmail(input.sessionRateLimits?.email),
  };
}

export function resolveComposerCodexRateLimits(input: {
  provider: ProviderDriverKind;
  session: OrchestrationSession | null;
  sessionRateLimits: ServerProviderRateLimits | null;
  providerRateLimits: ServerProviderRateLimits | null;
}): ServerProviderRateLimits | null {
  return resolveComposerCodexUsage(input).rateLimits;
}

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  planModeEnabled: boolean;
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const {
    provider,
    model,
    models,
    modelOptions,
    promptInjectionState = "none",
    planModeEnabled,
  } = input;
  if (provider === "opencode") {
    const normalizedModel = normalizeModelSlug(model, provider);
    const modelIsInCatalog = models.some((candidate) => candidate.slug === normalizedModel);
    if (!modelIsInCatalog) {
      const preservedOptions = modelOptions?.filter(
        (option) => planModeEnabled || option.id !== "agent" || option.value !== "plan",
      );
      return {
        provider,
        promptEffort: null,
        modelOptionsForDispatch:
          preservedOptions && preservedOptions.length > 0 ? preservedOptions : undefined,
      };
    }
  }
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
    planModeEnabled,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions,
      prompt,
      planModeEnabled,
    })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      prompt={prompt}
      onPromptChange={onPromptChange}
      planModeEnabled={planModeEnabled}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
