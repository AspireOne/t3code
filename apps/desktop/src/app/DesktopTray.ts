import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

export class DesktopTrayRegistrationError extends Schema.TaggedErrorClass<DesktopTrayRegistrationError>()(
  "DesktopTrayRegistrationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to register the Windows tray.";
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    readonly setOpenHandler: (open: () => void) => void;
    readonly allowMainWindowClose: () => void;
    readonly resetMainWindowClose: () => void;
    readonly shouldHideMainWindowOnClose: () => boolean;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const { logInfo: logTrayInfo, logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const context = yield* Effect.context<
    DesktopAssets.DesktopAssets | DesktopEnvironment.DesktopEnvironment | ElectronApp.ElectronApp
  >();
  const runPromise = Effect.runPromiseWith(context);

  let tray: Electron.Tray | undefined;
  let openMainWindow: (() => void) | undefined;
  let mainWindowCloseAllowed = false;

  const register = Effect.gen(function* () {
    if (environment.platform !== "win32" || tray !== undefined) {
      return;
    }

    const iconPath = Option.getOrUndefined((yield* assets.iconPaths).ico);
    if (iconPath === undefined) {
      yield* logTrayWarning("Windows tray unavailable because no .ico asset was found");
      return;
    }

    const createdTray = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const nextTray = new Electron.Tray(iconPath);
          const open = () => {
            openMainWindow?.();
          };
          const close = () => {
            void runPromise(electronApp.quit);
          };

          try {
            const menu = Electron.Menu.buildFromTemplate([
              { label: "Open", click: open },
              { type: "separator" },
              { label: "Close", click: close },
            ]);
            nextTray.setToolTip(environment.displayName);
            nextTray.setContextMenu(menu);
            nextTray.on("click", open);
          } catch (cause) {
            nextTray.destroy();
            throw cause;
          }

          return nextTray;
        },
        catch: (cause) => new DesktopTrayRegistrationError({ cause }),
      }),
      (created) =>
        Effect.sync(() => {
          created.destroy();
          if (tray === created) {
            tray = undefined;
            openMainWindow = undefined;
            mainWindowCloseAllowed = false;
          }
        }),
    );
    tray = createdTray;
    yield* logTrayInfo("Windows tray registered");
  }).pipe(
    Effect.catch((error) =>
      logTrayWarning("failed to register Windows tray", {
        message: error.message,
      }),
    ),
    Effect.withSpan("desktop.tray.register"),
  );

  return DesktopTray.of({
    register,
    setOpenHandler: (open) => {
      openMainWindow = open;
    },
    allowMainWindowClose: () => {
      mainWindowCloseAllowed = true;
    },
    resetMainWindowClose: () => {
      mainWindowCloseAllowed = false;
    },
    shouldHideMainWindowOnClose: () => tray !== undefined && !mainWindowCloseAllowed,
  });
});

export const layer = Layer.effect(DesktopTray, make);
