import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderAuth, ServerProviderRateLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";

import {
  type CodexRateLimitCoordinatorShape,
  makeCodexRateLimitCoordinator,
} from "./CodexRateLimitCoordinator.ts";
import {
  codexRateLimitAccountKeyFromAccount,
  codexRateLimitAccountKeyFromAuth,
  type CodexRateLimitAccountKey,
} from "./CodexRateLimits.ts";

const response = (usedPercent: number) => ({
  rateLimits: {
    primary: {
      usedPercent,
      windowDurationMins: 300,
      resetsAt: 1_900_000_000,
    },
  },
});

const accountKey = "chatgpt:test@example.com" as const;
const otherAccountKey = "chatgpt:other@example.com" as const;
const readLimits = (usedPercent: number, key: CodexRateLimitAccountKey = accountKey) =>
  Effect.succeed({ accountKey: key, rateLimits: response(usedPercent) });
describe("CodexRateLimitCoordinator", () => {
  it("derives the same normalized key from Codex and provider account shapes", () => {
    assert.strictEqual(
      codexRateLimitAccountKeyFromAccount({
        type: "chatgpt",
        email: " Test@Example.COM ",
        planType: "plus",
      }),
      accountKey,
    );
    assert.strictEqual(
      codexRateLimitAccountKeyFromAuth({
        status: "authenticated",
        type: "chatgpt",
        email: " Test@Example.COM ",
      } as ServerProviderAuth),
      accountKey,
    );
    assert.isNull(codexRateLimitAccountKeyFromAccount({ type: "apiKey" }));
    assert.isNull(
      codexRateLimitAccountKeyFromAuth({
        status: "authenticated",
        type: "apiKey",
      } as ServerProviderAuth),
    );
    assert.isUndefined(
      codexRateLimitAccountKeyFromAuth({ status: "unknown" } as ServerProviderAuth),
    );
  });

  it.effect("shares one active polling cadence across concurrent sessions", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const reads = yield* Ref.make(0);
      const read = () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.as({ accountKey, rateLimits: response(41) }),
        );

      yield* coordinator.registerSession("thread-a", read);
      yield* coordinator.registerSession("thread-b", read);
      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* coordinator.turnStarted("thread-b", "turn-b");
      yield* settleBackgroundWork;
      assert.strictEqual(yield* Ref.get(reads), 1);

      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(reads), 2);

      yield* coordinator.turnSettled("thread-a", "turn-a");
      yield* settleBackgroundWork;
      assert.strictEqual(yield* Ref.get(reads), 3);
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(reads), 4);

      yield* coordinator.turnSettled("thread-b", "turn-b");
      yield* settleBackgroundWork;
      assert.strictEqual(yield* Ref.get(reads), 5);
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(reads), 5);
    }),
  );

  it.effect("refetches a complete snapshot when Codex invalidates sparse limits", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const reads = yield* Ref.make(0);
      yield* coordinator.registerSession("thread-a", () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.map((count) => ({ accountKey, rateLimits: response(40 + count) })),
        ),
      );

      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* settleBackgroundWork;
      yield* coordinator.invalidate("thread-a");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.strictEqual(yield* Ref.get(reads), 2);
      assert.strictEqual((yield* coordinator.current)?.rateLimits.windows[0]?.usedPercent, 42);
    }),
  );

  it.effect("accepts limits fetched by the provider health lifecycle", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const rateLimits = rateLimitSnapshot(41, "2026-08-29T12:00:00.000Z");

      yield* coordinator.syncAccount(accountKey, rateLimits);

      assert.deepStrictEqual(yield* coordinator.current, {
        accountKey,
        rateLimits,
      });
    }),
  );

  it.effect("clears stale limits after a successful empty provider health read", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* coordinator.syncAccount(accountKey, rateLimitSnapshot(41, "2026-08-29T12:00:00.000Z"));

      yield* coordinator.syncAccount(accountKey, {
        fetchedAt: "2026-08-29T12:05:00.000Z",
        windows: [],
      });

      assert.isUndefined(yield* coordinator.current);
    }),
  );

  it.effect("clearing account state permits an immediate refresh", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const reads = yield* Ref.make(0);
      yield* coordinator.registerSession("thread-a", () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.as({ accountKey, rateLimits: response(41) }),
        ),
      );

      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* settleBackgroundWork;
      yield* coordinator.syncAccount(null);
      yield* coordinator.syncAccount(accountKey);
      yield* coordinator.registerSession("thread-a", () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.as({ accountKey, rateLimits: response(41) }),
        ),
      );
      yield* coordinator.turnStarted("thread-a", "turn-b");
      yield* settleBackgroundWork;

      assert.strictEqual(yield* Ref.get(reads), 2);
    }),
  );

  it.effect(
    "broadcasts changed limits immediately without repainting unchanged 30-second reads",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeCodexRateLimitCoordinator();
        const collectedFiber = yield* coordinator.changes.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const usedPercent = yield* Ref.make(41);
        yield* coordinator.registerSession("thread-a", () =>
          Ref.get(usedPercent).pipe(
            Effect.map((used) => ({ accountKey, rateLimits: response(used) })),
          ),
        );
        yield* coordinator.turnStarted("thread-a", "turn-a");
        yield* settleBackgroundWork;
        for (let poll = 0; poll < 10; poll += 1) {
          yield* TestClock.adjust("30 seconds");
          yield* settleBackgroundWork;
        }
        yield* Ref.set(usedPercent, 42);
        yield* TestClock.adjust("30 seconds");
        yield* settleBackgroundWork;

        const updates = Array.from(yield* Fiber.join(collectedFiber));
        assert.deepStrictEqual(
          updates.map((update) => update?.rateLimits.windows[0]?.usedPercent),
          [41, 41, 42],
        );
      }),
  );

  it.effect("rejects stale readers after a ChatGPT account switch", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* seedCurrent(coordinator, accountKey, 41);
      yield* coordinator.registerSession("old-session", () => readLimits(90, accountKey));
      yield* coordinator.registerSession("new-session", () => readLimits(20, otherAccountKey));

      yield* coordinator.syncAccount(otherAccountKey);
      yield* seedCurrent(coordinator, otherAccountKey, 20);
      yield* coordinator.invalidate("old-session");
      yield* settleBackgroundWork;

      assert.strictEqual((yield* coordinator.current)?.rateLimits.windows[0]?.usedPercent, 20);
    }),
  );

  it.effect(
    "only lets sessions notified for an account transition publish the new generation",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeCodexRateLimitCoordinator();
        yield* seedCurrent(coordinator, accountKey, 41);
        yield* coordinator.registerSession("old-session", () => readLimits(90, accountKey));
        yield* coordinator.registerSession("notified-session", () =>
          readLimits(20, otherAccountKey),
        );

        yield* coordinator.accountChanged("notified-session");
        yield* coordinator.invalidate("old-session");
        yield* settleBackgroundWork;

        const current = yield* coordinator.current;
        assert.strictEqual(current?.accountKey, otherAccountKey);
        assert.strictEqual(yield* coordinator.generation, 1);
        assert.strictEqual(current?.rateLimits.windows[0]?.usedPercent, 20);
      }),
  );

  it.effect("rejects a provider probe across repeated account-transition notifications", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* seedCurrent(coordinator, accountKey, 41);
      const probeGeneration = yield* coordinator.generation;

      yield* coordinator.accountChanged("session-a");
      yield* coordinator.accountChanged("session-b");
      yield* coordinator.syncAccount(
        accountKey,
        rateLimitSnapshot(90, "2026-08-29T12:01:00.000Z"),
        probeGeneration,
      );
      yield* settleBackgroundWork;

      assert.isUndefined(yield* coordinator.current);
      assert.strictEqual(yield* coordinator.generation, probeGeneration + 2);
    }),
  );

  it.effect("keeps limits cleared after logout even if an old ChatGPT reader remains", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* seedCurrent(coordinator, accountKey, 41);
      yield* coordinator.registerSession("old-session", () => readLimits(90, accountKey));

      yield* coordinator.syncAccount(null);
      yield* coordinator.invalidate("old-session");
      yield* settleBackgroundWork;

      assert.isUndefined(yield* coordinator.current);
    }),
  );

  it.effect("clears stale limits when a successful full read has no usable windows", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* seedCurrent(coordinator, accountKey, 41);
      yield* coordinator.registerSession("thread-a", () =>
        Effect.succeed({ accountKey, rateLimits: { rateLimits: {} } }),
      );

      yield* coordinator.invalidate("thread-a");
      yield* settleBackgroundWork;

      assert.isUndefined(yield* coordinator.current);
    }),
  );

  it.effect("falls back to a healthy reader after an active session exits", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* coordinator.registerSession("crashed", () =>
        Effect.fail(CodexAppServerRequestError.internalError("process exited")),
      );
      yield* coordinator.registerSession("healthy", () => readLimits(27));
      yield* coordinator.turnStarted("crashed", "turn-a");
      yield* settleBackgroundWork;
      yield* coordinator.unregisterSession("crashed");

      yield* coordinator.invalidate("crashed");
      yield* settleBackgroundWork;

      assert.strictEqual((yield* coordinator.current)?.rateLimits.windows[0]?.usedPercent, 27);
    }),
  );

  it.effect("preserves active polling through concurrent start and settle transitions", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const reads = yield* Ref.make(0);
      const reader = () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.as({ accountKey, rateLimits: response(41) }),
        );
      yield* coordinator.registerSession("thread-a", reader);
      yield* coordinator.registerSession("thread-b", reader);
      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* settleBackgroundWork;

      yield* Effect.all(
        [
          coordinator.turnSettled("thread-a", "turn-a"),
          coordinator.turnStarted("thread-b", "turn-b"),
        ],
        { concurrency: "unbounded", discard: true },
      );
      yield* settleBackgroundWork;
      const readsBeforeTick = yield* Ref.get(reads);

      yield* TestClock.adjust("30 seconds");
      yield* settleBackgroundWork;

      assert.strictEqual(yield* Ref.get(reads), readsBeforeTick + 1);
    }),
  );

  it.effect("coalesces concurrent invalidation and turn completion refreshes", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      const reads = yield* Ref.make(0);
      yield* coordinator.registerSession("thread-a", () =>
        Ref.updateAndGet(reads, (value) => value + 1).pipe(
          Effect.as({ accountKey, rateLimits: response(41) }),
        ),
      );
      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* settleBackgroundWork;

      yield* Effect.all(
        [coordinator.invalidate("thread-a"), coordinator.turnSettled("thread-a", "turn-a")],
        { concurrency: "unbounded", discard: true },
      );
      yield* settleBackgroundWork;

      assert.strictEqual(yield* Ref.get(reads), 2);
    }),
  );

  it.effect("retains the last successful snapshot when a later refresh fails", () =>
    Effect.gen(function* () {
      const coordinator = yield* makeCodexRateLimitCoordinator();
      yield* coordinator.registerSession("thread-a", () => readLimits(41));
      yield* coordinator.turnStarted("thread-a", "turn-a");
      yield* settleBackgroundWork;
      const successful = yield* coordinator.current;

      yield* coordinator.registerSession("thread-a", () =>
        Effect.fail(CodexAppServerRequestError.internalError("offline")),
      );
      yield* coordinator.invalidate("thread-a");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepStrictEqual(yield* coordinator.current, successful);
    }),
  );
});

const settleBackgroundWork = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow));

const seedCurrent = (
  coordinator: CodexRateLimitCoordinatorShape,
  key: CodexRateLimitAccountKey,
  usedPercent: number,
) =>
  Effect.gen(function* () {
    const sessionId = `seed:${key}`;
    yield* coordinator.registerSession(sessionId, () => readLimits(usedPercent, key));
    yield* coordinator.invalidate(sessionId);
    yield* settleBackgroundWork;
    yield* coordinator.unregisterSession(sessionId);
  });

function rateLimitSnapshot(usedPercent: number, fetchedAt: string): ServerProviderRateLimits {
  return {
    fetchedAt,
    windows: [
      {
        windowDurationMins: 300,
        usedPercent,
        resetsAt: "2030-03-17T17:46:40.000Z",
      },
    ],
  } as ServerProviderRateLimits;
}
