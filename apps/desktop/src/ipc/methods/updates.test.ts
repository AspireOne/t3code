import { assert, describe, it } from "@effect/vitest";

import { resolveUpstreamReleaseStatus } from "./updates.ts";

function githubRelease(version: string): Response {
  return Response.json({
    tag_name: `v${version}`,
  });
}

describe("upstream release status", () => {
  it("reports a newer stable upstream release", async () => {
    const status = await resolveUpstreamReleaseStatus({
      currentVersion: "0.0.35",
      fetch: async () => githubRelease("0.0.36"),
    });

    assert.deepEqual(status, {
      currentVersion: "0.0.35",
      latestVersion: "0.0.36",
      releaseUrl: "https://github.com/pingdotgg/t3code/releases/tag/v0.0.36",
      updateAvailable: true,
    });
  });

  it("does not report the same or an older release as an update", async () => {
    for (const latestVersion of ["0.0.35", "0.0.34"]) {
      const status = await resolveUpstreamReleaseStatus({
        currentVersion: "0.0.35",
        fetch: async () => githubRelease(latestVersion),
      });

      assert.equal(status?.updateAvailable, false);
    }
  });

  it("degrades silently when GitHub is unavailable or returns invalid data", async () => {
    const unavailable = await resolveUpstreamReleaseStatus({
      currentVersion: "0.0.35",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const invalid = await resolveUpstreamReleaseStatus({
      currentVersion: "0.0.35",
      fetch: async () => Response.json({ tag_name: "not-semver" }),
    });

    assert.isNull(unavailable);
    assert.isNull(invalid);
  });
});
