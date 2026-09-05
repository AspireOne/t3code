// @effect-diagnostics nodeBuiltinImport:off - Runs the installer shell with disposable state and fake Windows processes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This suite exercises the WSL-only installer on Linux.
const linuxIt = it.skipIf(NodeOS.platform() !== "linux");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-install-test-"));
  temporary.push(root);
  const repo = NodePath.join(root, "repo");
  for (const path of [
    "bin",
    "home/.t3",
    "roaming/t3code",
    "repo/apps/desktop",
    "repo/apps/server/node_modules/node-pty/build/Release",
  ]) {
    NodeFS.mkdirSync(NodePath.join(root, path), { recursive: true });
  }
  NodeFS.copyFileSync(
    NodeURL.fileURLToPath(new URL("../build-install-windows.sh", import.meta.url)),
    NodePath.join(repo, "build-install-windows.sh"),
  );
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "*\n");
  NodeFS.writeFileSync(NodePath.join(repo, "apps/desktop/package.json"), '{"version":"1.0.0"}');
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/node_modules/node-pty/build/Release/pty.node"),
    "fixture",
  );
  function command(name: string, body: string) {
    const path = NodePath.join(root, "bin", name);
    NodeFS.writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
    NodeFS.chmodSync(path, 0o755);
  }
  command("wine", "exit 0");
  command("wslpath", 'printf "%s\\n" "$2"');
  command("getent", 'printf "fixture:x:1000:1000::%s/home:/bin/bash\\n" "$FIXTURE"');
  command(
    "node",
    `printf ready > "$FIXTURE/gate"
if [[ -f "$FIXTURE/js-fail" ]]; then exit 9; fi
 touch "$FIXTURE/js-done"`,
  );
  command(
    "vp",
    `if [[ "$1" = i ]]; then exit; fi
[[ -f "$FIXTURE/js-done" && -f "$FIXTURE/rust-done" ]]
printf 'package\\n' >> "$FIXTURE/events"
mkdir -p release
printf installer > release/T3-Code-1.0.0-x64.exe`,
  );
  command(
    "pwsh.exe",
    `if [[ "$*" = *build-resource-monitor-windows.ps1* ]]; then
  cat "$FIXTURE/gate" >/dev/null
  touch "$FIXTURE/rust-done"
  if [[ -f "$FIXTURE/rust-fail" ]]; then exit 8; fi
elif [[ "$*" = *ApplicationData* ]]; then
  printf '%s/roaming\\n' "$FIXTURE"
elif [[ "$*" = *'Action Install'* ]]; then
  printf 'install\\n' >> "$FIXTURE/events"
fi`,
  );
  command(
    "rsync",
    `if [[ -f "$FIXTURE/backup-fail" ]]; then exit 23; fi
exec /usr/bin/rsync "$@"`,
  );
  NodeChildProcess.execFileSync("mkfifo", [NodePath.join(root, "gate")]);
  const git = (args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init"]);
  git(["add", "-f", "build-install-windows.sh", ".gitignore"]);
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
  git(["remote", "add", "upstream", "https://github.com/pingdotgg/t3code.git"]);
  const run = (...args: string[]) =>
    NodeChildProcess.spawnSync("bash", [NodePath.join(repo, "build-install-windows.sh"), ...args], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${NodePath.join(root, "bin")}:${process.env.PATH}`,
        FIXTURE: root,
        WSL_DISTRO_NAME: "fixture",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  return { root, run };
}

linuxIt.each(["js", "rust"])(
  "waits for both builds and never packages after a %s failure",
  (build) => {
    const { root, run } = fixture();
    NodeFS.writeFileSync(NodePath.join(root, `${build}-fail`), "");
    const result = run("--build-only");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(root, "rust-done"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "events"))).toBe(false);
  },
);

linuxIt(
  "keeps complete private snapshots, shares unchanged files, and never publishes a failed backup",
  () => {
    const { root, run } = fixture();
    const state = NodePath.join(root, "home/.t3");
    NodeFS.writeFileSync(NodePath.join(state, "unchanged"), "stable", { mode: 0o644 });
    NodeFS.writeFileSync(NodePath.join(state, "changed"), "old");
    NodeFS.writeFileSync(NodePath.join(state, "deleted"), "old");
    expect(run("--no-launch").status).toBe(0);
    const latest = NodePath.join(root, "t3code-backups/latest-windows-install");
    const first = NodeFS.realpathSync(latest);
    NodeFS.writeFileSync(NodePath.join(state, "changed"), "new contents");
    NodeFS.rmSync(NodePath.join(state, "deleted"));
    expect(run("--no-launch").status).toBe(0);
    const second = NodeFS.realpathSync(latest);
    expect(second).not.toBe(first);
    expect(NodeFS.statSync(NodePath.join(first, "wsl-t3/unchanged")).ino).toBe(
      NodeFS.statSync(NodePath.join(second, "wsl-t3/unchanged")).ino,
    );
    expect(NodeFS.statSync(NodePath.join(second, "wsl-t3/unchanged")).mode & 0o077).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(first, "wsl-t3/changed"), "utf8")).toBe("old");
    expect(NodeFS.readFileSync(NodePath.join(second, "wsl-t3/changed"), "utf8")).toBe(
      "new contents",
    );
    expect(NodeFS.existsSync(NodePath.join(first, "wsl-t3/deleted"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(second, "wsl-t3/deleted"))).toBe(false);
    NodeFS.writeFileSync(NodePath.join(root, "backup-fail"), "");
    expect(run("--no-launch").status).not.toBe(0);
    expect(NodeFS.realpathSync(latest)).toBe(second);
    expect(
      NodeFS.readFileSync(NodePath.join(root, "events"), "utf8").match(/^install$/gm),
    ).toHaveLength(2);
  },
);
