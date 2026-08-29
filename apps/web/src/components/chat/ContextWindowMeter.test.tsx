import { EventId, ServerProviderRateLimits, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import {
  ContextWindowMeter,
  formatRateLimitWindowLabel,
  rateLimitStaleDelay,
} from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

const decodeRateLimits = Schema.decodeUnknownSync(ServerProviderRateLimits);
const rateLimits = decodeRateLimits({
  fetchedAt: "2026-08-29T12:00:00.000Z",
  windows: [
    {
      windowDurationMins: 300,
      usedPercent: 41,
      resetsAt: "2026-08-29T14:00:00.000Z",
    },
    {
      windowDurationMins: 10_080,
      usedPercent: 45,
      resetsAt: "2026-09-05T12:00:00.000Z",
    },
  ],
});

describe("ContextWindowMeter", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} onCompact={() => {}} />);

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });

  it("presents Codex limits beside the context ring and explains both in one popover", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:05:00.000Z"));
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={usage} rateLimits={rateLimits} />,
    );

    expect(markup).toContain("data-rate-limits-inline");
    expect(markup).toContain("5h 59%");
    expect(markup).toContain("W 55%");
    expect(markup).toContain("Weekly limit");
    expect(markup).toContain(
      "Usage: context window 10% used, 5h limit 59% left, Weekly limit 55% left",
    );
    expect(markup).not.toContain("Last update may be stale");
  });

  it("keeps limits available from an icon when no context snapshot exists", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={null} rateLimits={rateLimits} compact />,
    );

    expect(markup).not.toContain("data-rate-limits-inline");
    expect(markup).toContain("Weekly limit");
    expect(markup).not.toContain('aria-label="Context window usage"');
  });

  it("warns about stale and nearly exhausted account limits without hiding them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:11:00.000Z"));
    const scarceLimits = decodeRateLimits({
      ...rateLimits,
      windows: [{ ...rateLimits.windows[0], usedPercent: 96 }],
    });
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={null} rateLimits={scarceLimits} />,
    );

    expect(markup).toContain("4% left");
    expect(markup).toContain("text-error");
    expect(markup).toContain("Last update may be stale");
  });

  it("formats known and provider-defined window durations compactly", () => {
    expect(formatRateLimitWindowLabel(300, false)).toBe("5h");
    expect(formatRateLimitWindowLabel(10_080, false)).toBe("Weekly");
    expect(formatRateLimitWindowLabel(10_080, true)).toBe("W");
    expect(formatRateLimitWindowLabel(1_440, false)).toBe("1d");
    expect(formatRateLimitWindowLabel(45, false)).toBe("45m");
  });

  it("schedules the stale transition at the exact ten-minute boundary", () => {
    const fetchedAt = "2026-08-29T12:00:00.000Z";
    expect(rateLimitStaleDelay(fetchedAt, Date.parse("2026-08-29T12:09:59.999Z"))).toBe(1);
    expect(rateLimitStaleDelay(fetchedAt, Date.parse("2026-08-29T12:10:00.000Z"))).toBe(0);
    expect(rateLimitStaleDelay(fetchedAt, Date.parse("2026-08-29T12:11:00.000Z"))).toBe(0);
  });
});
