// @effect-diagnostics nodeBuiltinImport:off - Exercises the real cache CLI in disposable workspaces.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";

import { pruneCache, restoreCache, saveCache } from "./lib/windows-build-cache.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This suite exercises the WSL-only bootstrap on Linux.
const linuxIt = it.skipIf(NodeOS.platform() !== "linux");
const temporary: string[] = [];
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-cache-test-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

linuxIt("restores independent files and relative dependency symlinks", () => {
  const root = fixture();
  const source = NodePath.join(root, "source");
  const cache = NodePath.join(root, "cache");
  const restored = NodePath.join(root, "restored");
  NodeFS.mkdirSync(source);
  NodeFS.writeFileSync(NodePath.join(source, "native.node"), "original");
  NodeFS.symlinkSync("native.node", NodePath.join(source, "link"));
  saveCache(cache, [source]);
  NodeFS.rmSync(source, { recursive: true });
  expect(restoreCache(cache, [restored])).toBe(true);
  expect(NodeFS.readFileSync(NodePath.join(restored, "link"), "utf8")).toBe("original");
  NodeFS.writeFileSync(NodePath.join(restored, "native.node"), "packaging mutation");
  expect(restoreCache(cache, [restored])).toBe(true);
  expect(NodeFS.readFileSync(NodePath.join(restored, "native.node"), "utf8")).toBe("original");
});

linuxIt("rejects altered or incomplete cache payloads without touching the destination", () => {
  const root = fixture();
  const source = NodePath.join(root, "source");
  const cache = NodePath.join(root, "cache");
  NodeFS.writeFileSync(source, "good");
  saveCache(cache, [source]);
  NodeFS.writeFileSync(NodePath.join(cache, "0"), "evil");
  expect(restoreCache(cache, [source])).toBe(false);
  expect(NodeFS.readFileSync(source, "utf8")).toBe("good");
  NodeFS.rmSync(NodePath.join(cache, "0"));
  expect(restoreCache(cache, [source])).toBe(false);
});

linuxIt("bounds cache history without removing the newest entries", () => {
  const root = fixture();
  const source = NodePath.join(root, "source");
  const cacheRoot = NodePath.join(root, "cache");
  NodeFS.writeFileSync(source, "payload");
  for (const [index, name] of ["old", "middle", "new"].entries()) {
    const entry = NodePath.join(cacheRoot, name);
    saveCache(entry, [source]);
    NodeFS.utimesSync(entry, 1_000 + index, 1_000 + index);
  }
  pruneCache(cacheRoot, 2);
  expect(NodeFS.existsSync(NodePath.join(cacheRoot, "old"))).toBe(false);
  expect(NodeFS.existsSync(NodePath.join(cacheRoot, "middle"))).toBe(true);
  expect(NodeFS.existsSync(NodePath.join(cacheRoot, "new"))).toBe(true);
});

function cliFixture() {
  const root = fixture();
  for (const dir of [
    "scripts/lib",
    "apps/web",
    "apps/server",
    "apps/desktop",
    "packages",
    "infra",
    "oxlint-plugin-t3code",
    "bin",
    "stage",
  ]) {
    NodeFS.mkdirSync(NodePath.join(root, dir), { recursive: true });
  }
  for (const path of ["windows-build-cache.ts", "lib/windows-build-cache.ts"]) {
    NodeFS.copyFileSync(
      NodeURL.fileURLToPath(new URL(path, import.meta.url)),
      NodePath.join(root, "scripts", path),
    );
  }
  const vp = NodePath.join(root, "bin/vp");
  NodeFS.writeFileSync(
    vp,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo fixture-v1; exit; fi
printf 'run\\n' >> "$COUNTER"
if [ -f "$FAIL_FILE" ]; then exit 7; fi
if [ "$1" = "install" ]; then
  mkdir -p node_modules
  printf 'dependency' > node_modules/package.js
else
  mkdir -p apps/web/dist apps/server/dist apps/desktop/dist-electron
  cp input.ts apps/web/dist/index.html
  cp input.ts apps/server/dist/bin.mjs
  cp input.ts apps/desktop/dist-electron/main.cjs
fi
`,
  );
  NodeFS.chmodSync(vp, 0o755);
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "input.ts",
    "stage/package.json",
    "stage/pnpm-workspace.yaml",
  ]) {
    NodeFS.writeFileSync(
      NodePath.join(root, path),
      path.endsWith("package.json")
        ? '{"name":"fixture","version":"1.0.0","dependencies":{"fixture":"1.0.0"}}'
        : "initial",
    );
  }
  NodeFS.mkdirSync(NodePath.join(root, "node_modules"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "node_modules/.modules.yaml"), "initial tools");
  const git = (args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init"]);
  git(["add", "input.ts", "scripts", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const counter = NodePath.join(root, "counter");
  const run = (mode = "build", environment: Record<string, string> = {}) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, "scripts/windows-build-cache.ts"), mode],
      {
        cwd: NodePath.join(root, "stage"),
        env: {
          ...process.env,
          PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
          T3CODE_WINDOWS_BUILD_CACHE: NodePath.join(root, "cache"),
          COUNTER: counter,
          FAIL_FILE: NodePath.join(root, "fail"),
          ...environment,
        },
        encoding: "utf8",
      },
    );
  return { root, run, runs: () => NodeFS.readFileSync(counter, "utf8").trim().split("\n").length };
}

linuxIt(
  "reuses builds, restores packaging mutations, and invalidates source, env, and installed-tool changes",
  () => {
    const { root, run, runs } = cliFixture();
    expect(run().status).toBe(0);
    const modulesMetadata = NodePath.join(root, "node_modules/.modules.yaml");
    const modulesStat = NodeFS.statSync(modulesMetadata);
    NodeFS.utimesSync(modulesMetadata, modulesStat.atimeMs + 1_000, modulesStat.mtimeMs + 1_000);
    expect(run().status).toBe(0);
    expect(runs()).toBe(1);
    NodeFS.writeFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), "branding mutation");
    expect(run().status).toBe(0);
    expect(runs()).toBe(1);
    expect(NodeFS.readFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), "utf8")).toBe(
      "initial",
    );
    NodeFS.writeFileSync(NodePath.join(root, "input.ts"), "changed");
    expect(run().status).toBe(0);
    expect(runs()).toBe(2);
    NodeFS.writeFileSync(NodePath.join(root, ".env.local"), "VITE_EXAMPLE=changed");
    expect(run().status).toBe(0);
    expect(runs()).toBe(3);
    NodeFS.writeFileSync(NodePath.join(root, "node_modules/.modules.yaml"), "changed tool");
    expect(run().status).toBe(0);
    expect(runs()).toBe(4);
    expect(run("build", { APP_VERSION: "new-version" }).status).toBe(0);
    expect(runs()).toBe(5);
  },
);

linuxIt(
  "never caches failed commands, and invalidates staged dependencies when the lockfile changes",
  () => {
    const { root, run, runs } = cliFixture();
    NodeFS.writeFileSync(NodePath.join(root, "fail"), "");
    expect(run("dependencies").status).not.toBe(0);
    NodeFS.rmSync(NodePath.join(root, "fail"));
    expect(run("dependencies").status).toBe(0);
    NodeFS.rmSync(NodePath.join(root, "stage/node_modules"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "stage/package.json"),
      '{"name":"fixture","version":"2.0.0","dependencies":{"fixture":"1.0.0"}}',
    );
    expect(run("dependencies").status).toBe(0);
    expect(runs()).toBe(2);
    NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "changed");
    expect(run("dependencies").status).toBe(0);
    expect(runs()).toBe(3);
  },
);
