import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";

import { bindCodexRateLimits, normalizeCodexRateLimits } from "./CodexRateLimits.ts";

const fetchedAt = "2026-08-29T12:00:00.000Z";

describe("normalizeCodexRateLimits", () => {
  it("prefers the Codex bucket and orders windows by duration", () => {
    const result = normalizeCodexRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: 1_900_000_000 },
        },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
            secondary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          },
        },
      },
      fetchedAt,
    );

    expect(result).toEqual({
      fetchedAt,
      windows: [
        {
          windowDurationMins: 300,
          usedPercent: 41,
          resetsAt: "2030-03-17T17:46:40.000Z",
        },
        {
          windowDurationMins: 10_080,
          usedPercent: 45,
          resetsAt: "2033-05-18T03:33:20.000Z",
        },
      ],
    });
  });

  it("falls back to the backward-compatible single bucket", () => {
    const result = normalizeCodexRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        },
      },
      fetchedAt,
    );

    expect(result?.windows).toHaveLength(1);
    expect(result?.windows[0]?.usedPercent).toBe(24);
  });

  it("keeps usable windows while rejecting invalid metadata and clamping percentages", () => {
    const result = normalizeCodexRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 101.4, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 50, windowDurationMins: 0, resetsAt: 2_000_000_000 },
        },
      },
      fetchedAt,
    );

    expect(result?.windows).toEqual([
      {
        windowDurationMins: 300,
        usedPercent: 100,
        resetsAt: "2030-03-17T17:46:40.000Z",
      },
    ]);
  });

  it("omits quota state when Codex returns no usable timed window", () => {
    expect(
      normalizeCodexRateLimits(
        {
          rateLimits: {
            primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: 1_900_000_000 },
            secondary: { usedPercent: 50 },
          },
        },
        fetchedAt,
      ),
    ).toBeUndefined();
  });
});

describe("bindCodexRateLimits", () => {
  const rateLimits = {
    fetchedAt,
    windows: [
      {
        windowDurationMins: 300,
        usedPercent: 41,
        resetsAt: "2030-03-17T17:46:40.000Z",
      },
    ],
  } as const;
  const provider = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt", email: "account-a@example.com" },
    checkedAt: fetchedAt,
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;

  it("attaches limits only to the exact authenticated ChatGPT account", () => {
    const bound = bindCodexRateLimits(provider, {
      accountKey: "chatgpt:account-a@example.com",
      rateLimits,
    });
    const mismatched = bindCodexRateLimits(provider, {
      accountKey: "chatgpt:account-b@example.com",
      rateLimits,
    });

    expect(bound.rateLimits).toBe(rateLimits);
    expect(mismatched).not.toHaveProperty("rateLimits");
  });

  it("removes previously attached limits when auth is no longer verified", () => {
    const staleProvider = {
      ...provider,
      auth: { status: "unknown" },
      rateLimits,
    } as ServerProvider;

    expect(
      bindCodexRateLimits(staleProvider, {
        accountKey: "chatgpt:account-a@example.com",
        rateLimits,
      }),
    ).not.toHaveProperty("rateLimits");
  });
});
