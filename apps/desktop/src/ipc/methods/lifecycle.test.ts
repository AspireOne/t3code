import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { restartDesktop } from "./lifecycle.ts";

const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

describe("desktop lifecycle IPC", () => {
  it.effect("requests a command-palette relaunch", () => {
    const reasons: Array<string> = [];
    const lifecycleLayer = Layer.succeed(
      DesktopLifecycle.DesktopLifecycle,
      DesktopLifecycle.DesktopLifecycle.of({
        relaunch: (reason) =>
          Effect.sync(() => {
            reasons.push(reason);
          }),
        register: Effect.void,
      }),
    );

    return restartDesktop.handler(undefined).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.deepEqual(reasons, ["command-palette"]);
        }),
      ),
      Effect.provide(Layer.merge(lifecycleLayer, unusedLifecycleRuntimeLayer)),
    );
  });
});
