import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  DesktopUpstreamReleaseStatusSchema,
} from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannelSchema,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel);
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.install;
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("web-ui");
  }),
});

const UPSTREAM_LATEST_RELEASE_URL = "https://api.github.com/repos/pingdotgg/t3code/releases/latest";

const UpstreamRelease = Schema.Struct({
  tag_name: Schema.String,
});
const decodeUpstreamRelease = Schema.decodeUnknownPromise(UpstreamRelease);

export async function resolveUpstreamReleaseStatus(input: {
  currentVersion: string;
  fetch: typeof globalThis.fetch;
}) {
  try {
    const response = await input.fetch(UPSTREAM_LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const release = await decodeUpstreamRelease(await response.json());
    const latestVersion = release.tag_name.trim().replace(/^v/, "");
    if (!parseSemver(input.currentVersion) || !parseSemver(latestVersion)) return null;

    return {
      currentVersion: input.currentVersion,
      latestVersion,
      releaseUrl: `https://github.com/pingdotgg/t3code/releases/tag/v${encodeURIComponent(latestVersion)}`,
      updateAvailable: compareSemverVersions(latestVersion, input.currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

export const checkUpstreamRelease = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPSTREAM_RELEASE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopUpstreamReleaseStatusSchema),
  handler: Effect.fn("desktop.ipc.updates.checkUpstreamRelease")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      resolveUpstreamReleaseStatus({
        currentVersion: environment.appVersion,
        fetch: globalThis.fetch,
      }),
    );
  }),
});
