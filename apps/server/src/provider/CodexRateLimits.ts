import type {
  ServerProvider,
  ServerProviderAuth,
  ServerProviderRateLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexSchema from "effect-codex-app-server/schema";

export type CodexRateLimitAccountKey = `chatgpt:${string}`;

export function codexRateLimitAccountKeyFromAccount(
  account: CodexSchema.V2GetAccountResponse["account"],
): CodexRateLimitAccountKey | null {
  if (account?.type !== "chatgpt") return null;
  return `chatgpt:${account.email?.trim().toLowerCase() || "<unknown>"}`;
}

export function codexRateLimitAccountKeyFromAuth(
  auth: ServerProviderAuth,
): CodexRateLimitAccountKey | null | undefined {
  if (auth.type === "chatgpt") {
    return `chatgpt:${auth.email?.trim().toLowerCase() || "<unknown>"}`;
  }
  if (auth.status === "unauthenticated" || auth.type !== undefined) {
    return null;
  }
  return undefined;
}

export function bindCodexRateLimits(
  provider: ServerProvider,
  snapshot:
    | {
        readonly accountKey: CodexRateLimitAccountKey;
        readonly rateLimits: ServerProviderRateLimits;
      }
    | undefined,
): ServerProvider {
  const accountKey = codexRateLimitAccountKeyFromAuth(provider.auth);
  if (accountKey !== undefined && accountKey !== null && snapshot?.accountKey === accountKey) {
    return { ...provider, rateLimits: snapshot.rateLimits };
  }
  const { rateLimits: _rateLimits, ...withoutRateLimits } = provider;
  return withoutRateLimits;
}

function normalizeWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderRateLimits["windows"][number] | null {
  if (
    !window ||
    !Number.isFinite(window.usedPercent) ||
    !Number.isInteger(window.windowDurationMins) ||
    (window.windowDurationMins ?? 0) <= 0 ||
    !Number.isInteger(window.resetsAt) ||
    (window.resetsAt ?? 0) <= 0
  ) {
    return null;
  }

  const reset = DateTime.make((window.resetsAt ?? 0) * 1_000);
  if (Option.isNone(reset)) {
    return null;
  }

  return {
    windowDurationMins: window.windowDurationMins ?? 0,
    usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
    resetsAt: DateTime.formatIso(reset.value),
  };
}

/** Normalize the stable Codex account quota bucket into the provider wire shape. */
export function normalizeCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  fetchedAt: string,
): ServerProviderRateLimits | undefined {
  const limits = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  const windows = [limits.primary, limits.secondary]
    .map(normalizeWindow)
    .filter((window): window is NonNullable<typeof window> => window !== null)
    .toSorted((left, right) => left.windowDurationMins - right.windowDurationMins);

  return windows.length > 0 ? { fetchedAt, windows } : undefined;
}
