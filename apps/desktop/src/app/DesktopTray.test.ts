import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const {
  menuBuildFromTemplateMock,
  trayConstructorMock,
  trayDestroyMock,
  trayOnMock,
  traySetContextMenuMock,
  traySetToolTipMock,
} = vi.hoisted(() => {
  const menuBuildFromTemplateMock = vi.fn(
    (_template: readonly Electron.MenuItemConstructorOptions[]) => ({}) as Electron.Menu,
  );
  const trayDestroyMock = vi.fn();
  const trayOnMock = vi.fn(
    (_eventName: string, _listener: (...args: ReadonlyArray<unknown>) => void) => undefined,
  );
  const traySetContextMenuMock = vi.fn((_menu: Electron.Menu) => undefined);
  const traySetToolTipMock = vi.fn((_toolTip: string) => undefined);
  const trayConstructorMock = vi.fn(function TrayMock(
    this: Record<string, unknown>,
    _image: string,
  ) {
    this.destroy = trayDestroyMock;
    this.on = trayOnMock;
    this.setContextMenu = traySetContextMenuMock;
    this.setToolTip = traySetToolTipMock;
  });

  return {
    menuBuildFromTemplateMock,
    trayConstructorMock,
    trayDestroyMock,
    trayOnMock,
    traySetContextMenuMock,
    traySetToolTipMock,
  };
});

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: menuBuildFromTemplateMock,
  },
  Tray: trayConstructorMock,
}));

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

function makeAssetsLayer(ico: Option.Option<string> = Option.some("/resources/icon.ico")) {
  return Layer.succeed(DesktopAssets.DesktopAssets, {
    iconPaths: Effect.succeed({
      ico,
      icns: Option.none(),
      png: Option.none(),
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  } satisfies DesktopAssets.DesktopAssets["Service"]);
}

function makeElectronAppLayer(onQuit: () => void) {
  return Layer.mock(ElectronApp.ElectronApp)({
    quit: Effect.sync(onQuit),
  });
}

function makeEnvironmentLayer(platform: NodeJS.Platform) {
  return Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform,
    displayName: "T3 Code (Alpha)",
  } as DesktopEnvironment.DesktopEnvironment["Service"]);
}

function makeTrayLayer(
  platform: NodeJS.Platform,
  onQuit: () => void = () => undefined,
  ico: Option.Option<string> = Option.some("/resources/icon.ico"),
) {
  return DesktopTray.layer.pipe(
    Layer.provideMerge(makeAssetsLayer(ico)),
    Layer.provideMerge(makeElectronAppLayer(onQuit)),
    Layer.provideMerge(makeEnvironmentLayer(platform)),
  );
}

function getMenuItem(index: number): Electron.MenuItemConstructorOptions {
  const item = menuBuildFromTemplateMock.mock.calls[0]?.[0]?.[index];
  if (item === undefined || typeof item !== "object") {
    throw new Error(`Expected tray menu item at index ${index}`);
  }
  return item;
}

describe("DesktopTray", () => {
  beforeEach(() => {
    menuBuildFromTemplateMock.mockClear();
    trayConstructorMock.mockClear();
    trayDestroyMock.mockClear();
    trayOnMock.mockClear();
    traySetContextMenuMock.mockClear();
    traySetToolTipMock.mockClear();
  });

  it.effect("registers a Windows tray that reopens and quits the app", () => {
    let quitCount = 0;
    let revealCount = 0;

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tray = yield* DesktopTray.DesktopTray;
          yield* tray.register;
          tray.setOpenHandler(() => {
            revealCount += 1;
          });

          assert.deepEqual(trayConstructorMock.mock.calls, [["/resources/icon.ico"]]);
          assert.deepEqual(traySetToolTipMock.mock.calls, [["T3 Code (Alpha)"]]);
          assert.equal(traySetContextMenuMock.mock.calls.length, 1);
          assert.deepEqual(
            menuBuildFromTemplateMock.mock.calls[0]?.[0]?.map((item) => item.label ?? item.type),
            ["Open", "separator", "Close"],
          );
          assert.isTrue(tray.shouldHideMainWindowOnClose());
          tray.allowMainWindowClose();
          assert.isFalse(tray.shouldHideMainWindowOnClose());
          tray.resetMainWindowClose();
          assert.isTrue(tray.shouldHideMainWindowOnClose());

          const open = getMenuItem(0).click;
          if (typeof open !== "function") {
            return yield* Effect.die("Expected Open tray item to have a click handler");
          }
          open({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
          assert.equal(revealCount, 1);

          const trayClick = trayOnMock.mock.calls[0]?.[1];
          if (typeof trayClick !== "function") {
            return yield* Effect.die("Expected tray click listener");
          }
          trayClick();
          assert.equal(revealCount, 2);

          const close = getMenuItem(2).click;
          if (typeof close !== "function") {
            return yield* Effect.die("Expected Close tray item to have a click handler");
          }
          close({} as Electron.MenuItem, undefined, {} as KeyboardEvent);
          yield* Effect.promise(() => Promise.resolve());

          assert.equal(quitCount, 1);
        }),
      );

      assert.equal(trayDestroyMock.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeTrayLayer("win32", () => {
          quitCount += 1;
        }),
      ),
    );
  });

  it.effect("does not create a tray outside Windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        yield* tray.register;

        assert.equal(trayConstructorMock.mock.calls.length, 0);
        assert.isFalse(tray.shouldHideMainWindowOnClose());
      }),
    ).pipe(Effect.provide(makeTrayLayer("darwin"))),
  );

  it.effect("falls back to normal close behavior when the tray icon is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        yield* tray.register;

        assert.equal(trayConstructorMock.mock.calls.length, 0);
        assert.isFalse(tray.shouldHideMainWindowOnClose());
      }),
    ).pipe(Effect.provide(makeTrayLayer("win32", () => undefined, Option.none()))),
  );

  it.effect("falls back to normal close behavior when tray creation fails", () => {
    trayConstructorMock.mockImplementationOnce(() => {
      throw new Error("tray unavailable");
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        yield* tray.register;

        assert.isFalse(tray.shouldHideMainWindowOnClose());
      }),
    ).pipe(Effect.provide(makeTrayLayer("win32")));
  });
});
