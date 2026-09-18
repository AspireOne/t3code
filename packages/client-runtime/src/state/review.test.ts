import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createReviewEnvironmentAtoms } from "./review.ts";
import { createVcsEnvironmentAtoms } from "./vcs.ts";

it.effect("refreshes an open diff after both successful and partially failed Git actions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("review-environment");
      let patch = "before action";
      let previewReads = 0;
      let fail = false;
      const client = {
        [WS_METHODS.reviewGetDiffPreview]: () =>
          Effect.sync(() => {
            previewReads += 1;
            return {
              cwd: "/repo",
              generatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree",
                  title: "Working tree",
                  baseRef: "HEAD",
                  headRef: null,
                  diff: patch,
                  diffHash: patch,
                  truncated: false,
                },
              ],
            };
          }),
        [WS_METHODS.vcsInit]: () =>
          Effect.sync(() => {
            patch = fail ? "partial action" : "after action";
          }).pipe(
            Effect.andThen(() =>
              fail
                ? Effect.fail(
                    new EnvironmentRpcUnavailableError({
                      environmentId,
                      message: "failed after mutation",
                    }),
                  )
                : Effect.void,
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Review",
          httpBaseUrl: "https://review.example.test",
          wsBaseUrl: "wss://review.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry, environments),
          Layer.mock(EnvironmentCacheStore)({ clearVcsRefs: () => Effect.void }),
        ),
      );
      const review = createReviewEnvironmentAtoms(runtime);
      const vcs = createVcsEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const target = { environmentId, input: { cwd: "/repo" } };
      const preview = review.diffPreview(target);
      const unmount = registry.mount(preview);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).sources[0]
          ?.diff,
      ).toBe("before action");
      yield* Effect.promise(() => vcs.init.run(registry, target));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).sources[0]
          ?.diff,
      ).toBe("after action");
      fail = true;
      yield* Effect.promise(() => vcs.init.run(registry, target));
      expect(
        (yield* AtomRegistry.getResult(registry, preview, { suspendOnWaiting: true })).sources[0]
          ?.diff,
      ).toBe("partial action");
      unmount();
      yield* Effect.yieldNow;
      const readsBeforeClosing = previewReads;
      fail = false;
      yield* Effect.promise(() => vcs.init.run(registry, target));
      yield* Effect.yieldNow;
      expect(previewReads).toBe(readsBeforeClosing);
    }),
  ),
);
