import type { OrchestrationThreadShell, ServerConfig } from "@t3tools/contracts";
import { hasQueuedTurnStart } from "./state/threadSettled.ts";

export function canForkThread(
  thread: OrchestrationThreadShell,
  config: Pick<ServerConfig, "environment" | "providers"> | null | undefined,
  options: {
    readonly fromTurn?: boolean;
    readonly now: string;
    readonly queuedMessageCount?: number;
    readonly hasPendingTurnStart?: boolean;
  },
): boolean {
  const capabilities = config?.environment.capabilities;
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return (
    capabilities?.threadForking === true &&
    thread.archivedAt === null &&
    (!options.fromTurn || capabilities.threadForkingFromTurn === true) &&
    config?.providers.find((provider) => provider.instanceId === instanceId)?.driver === "codex" &&
    thread.latestTurn?.completedAt != null &&
    thread.latestTurn.state !== "running" &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running" &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    (options.queuedMessageCount ?? 0) === 0 &&
    options.hasPendingTurnStart !== true &&
    !hasQueuedTurnStart(thread, { now: options.now })
  );
}
