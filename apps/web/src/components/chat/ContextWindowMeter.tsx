import type { ServerProviderRateLimits } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { GaugeIcon, Minimize2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";

const STALE_AFTER_MS = 10 * 60 * 1_000;

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  rateLimits?: ServerProviderRateLimits | undefined;
  accountEmail?: string | null | undefined;
  compact?: boolean | undefined;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const {
    usage,
    rateLimits,
    accountEmail,
    compact,
    modelDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
  } = props;
  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const limitWindows = rateLimits?.windows.slice(0, 2) ?? [];
  const hasRateLimits = limitWindows.length > 0;
  const isStale = useRateLimitSnapshotStaleness(rateLimits?.fetchedAt);
  const ariaParts = [
    accountEmail ? `account ${accountEmail}` : null,
    usage
      ? usage.maxTokens !== null && usedPercentage
        ? `context window ${usedPercentage} used`
        : `context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
      : null,
    ...limitWindows.map(
      (window) =>
        `${formatRateLimitWindowLabel(window.windowDurationMins, false)} limit ${100 - window.usedPercent}% left`,
    ),
  ].filter(Boolean);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size={compact || !hasRateLimits ? "icon-sm" : "sm"}
            variant="ghost-muted"
            className={cn(
              "rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground",
              compact || !hasRateLimits ? "size-7" : "h-7 gap-1.5 px-1.5",
            )}
            aria-label={`Usage: ${ariaParts.join(", ")}`}
          >
            {!compact && hasRateLimits ? (
              <span
                data-rate-limits-inline
                className="flex items-center gap-1 text-[11px] tabular-nums"
              >
                {limitWindows.map((window, index) => (
                  <span key={window.windowDurationMins} className="contents">
                    {index > 0 ? <span className="text-border">·</span> : null}
                    <span className={rateLimitTextColor(100 - window.usedPercent)}>
                      {formatRateLimitWindowLabel(window.windowDurationMins, true)}{" "}
                      {100 - window.usedPercent}%
                    </span>
                  </span>
                ))}
              </span>
            ) : null}
            {usage ? (
              <span className="relative flex size-5 items-center justify-center">
                <svg
                  viewBox="0 0 24 24"
                  className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                    strokeWidth="3"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke={usageColor}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                  />
                </svg>
              </span>
            ) : (
              <GaugeIcon className="size-4" aria-hidden="true" />
            )}
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
          <div className="font-medium text-muted-foreground text-xs">Usage</div>
          {accountEmail ? (
            <div className="flex min-w-0 items-start justify-between gap-3 text-[11px]">
              <span className="shrink-0 text-secondary-label">Account</span>
              <span className="min-w-0 break-all text-right font-medium text-secondary-label">
                {accountEmail}
              </span>
            </div>
          ) : null}
          {usage ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-secondary-label text-[11px]">Context window</div>
                {usage.maxTokens !== null && usedPercentage ? (
                  <div className="text-secondary-label text-[11px] tabular-nums">
                    <span>{usedPercentage}</span>
                    <span className="mx-1">·</span>
                    <span>
                      {formatContextWindowTokens(usage.usedTokens)}/
                      {formatContextWindowTokens(usage.maxTokens ?? null)}
                    </span>
                  </div>
                ) : (
                  <div className="text-secondary-label text-[11px] tabular-nums">
                    {formatContextWindowTokens(usage.usedTokens)}
                  </div>
                )}
              </div>
              {usage.maxTokens !== null ? (
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(normalizedPercentage)}
                  aria-label="Context window usage"
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
                  />
                </div>
              ) : null}
              {showTotalProcessed ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-secondary-label">Total processed</span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {formatContextWindowTokens(totalProcessedTokens)}
                  </span>
                </div>
              ) : null}
              {usage.compactsAutomatically ? (
                <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
                  {formatContextWindowCompactionMessage(
                    modelDisplayName,
                    usage.autoCompactThreshold,
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {hasRateLimits ? (
            <div className={cn("flex flex-col gap-2", usage && "border-border/60 border-t pt-2.5")}>
              {limitWindows.map((window) => {
                const remainingPercent = 100 - window.usedPercent;
                return (
                  <div key={window.windowDurationMins} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="text-secondary-label">
                        {formatRateLimitWindowLabel(window.windowDurationMins, false)} limit
                      </span>
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          rateLimitTextColor(remainingPercent),
                        )}
                      >
                        {remainingPercent}% left
                      </span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={remainingPercent}
                      aria-label={`${formatRateLimitWindowLabel(window.windowDurationMins, false)} limit remaining`}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${remainingPercent}%`,
                          backgroundColor: rateLimitBarColor(remainingPercent),
                        }}
                      />
                    </div>
                    <div className="text-right text-secondary-label text-[10px] tabular-nums">
                      Resets {formatResetTime(window.resetsAt)}
                    </div>
                  </div>
                );
              })}
              {isStale ? (
                <div className="text-secondary-label text-[10px]">Last update may be stale</div>
              ) : null}
            </div>
          ) : null}
          {onCompact && usage ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function useRateLimitSnapshotStaleness(fetchedAt: string | undefined): boolean {
  const [expiredSnapshot, setExpiredSnapshot] = useState<string | null>(null);
  const staleDelay = fetchedAt ? rateLimitStaleDelay(fetchedAt, Date.now()) : null;

  useEffect(() => {
    if (!fetchedAt || staleDelay === null || staleDelay <= 0) return;
    const timeout = setTimeout(() => setExpiredSnapshot(fetchedAt), staleDelay);
    return () => clearTimeout(timeout);
  }, [fetchedAt, staleDelay]);

  return staleDelay === 0 || expiredSnapshot === fetchedAt;
}

export function rateLimitStaleDelay(fetchedAt: string, now: number): number {
  return Math.max(0, Date.parse(fetchedAt) + STALE_AFTER_MS - now);
}

export function formatRateLimitWindowLabel(durationMins: number, abbreviated: boolean): string {
  if (durationMins === 10_080) return abbreviated ? "W" : "Weekly";
  if (durationMins % 1_440 === 0) return `${durationMins / 1_440}d`;
  if (durationMins % 60 === 0) return `${durationMins / 60}h`;
  return `${durationMins}m`;
}

function rateLimitTextColor(remainingPercent: number): string {
  if (remainingPercent <= 5) return "text-error";
  if (remainingPercent <= 20) return "text-warning";
  return "text-secondary-label";
}

function rateLimitBarColor(remainingPercent: number): string {
  if (remainingPercent <= 5) return "var(--color-error)";
  if (remainingPercent <= 20) return "var(--color-warning)";
  return "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
}

function formatResetTime(resetsAt: string): string {
  const date = new Date(resetsAt);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
