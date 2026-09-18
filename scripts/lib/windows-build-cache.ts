// @effect-diagnostics nodeBuiltinImport:off - Local build bootstrap runs before the Effect artifact builder.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Hash cache inputs and payloads, including file contents and link targets. */
export function fingerprintPaths(paths: readonly string[]): string {
  const hash = NodeCrypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  function visit(path: string, name: string) {
    hash.update(JSON.stringify(name));
    const stat = NodeFS.lstatSync(path, { throwIfNoEntry: false });
    if (!stat) {
      hash.update("missing");
    } else if (stat.isSymbolicLink()) {
      hash.update(`link:${NodeFS.readlinkSync(path)}`);
    } else if (stat.isDirectory()) {
      hash.update(`directory:${stat.mode}`);
      for (const entry of NodeFS.readdirSync(path).sort()) {
        visit(NodePath.join(path, entry), `${name}/${entry}`);
      }
    } else if (stat.isFile()) {
      hash.update(`file:${stat.mode}:${stat.size}:`);
      const fd = NodeFS.openSync(path, "r");
      try {
        let length;
        while ((length = NodeFS.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length));
      } finally {
        NodeFS.closeSync(fd);
      }
    } else {
      throw new Error(`Unsupported cache input: ${path}`);
    }
  }
  paths.forEach((path, index) => visit(path, String(index)));
  return hash.digest("hex");
}

/** Restore independent copies only after checking the entire cached payload. Caller owns the lock. */
export function restoreCache(entry: string, destinations: readonly string[]): boolean {
  const payloads = destinations.map((_, index) => NodePath.join(entry, String(index)));
  const receipt = NodePath.join(entry, "sha256");
  if (!NodeFS.existsSync(receipt) || payloads.some((path) => !NodeFS.existsSync(path)))
    return false;
  if (NodeFS.readFileSync(receipt, "utf8") !== fingerprintPaths(payloads)) return false;
  destinations.forEach((destination, index) => {
    NodeFS.rmSync(destination, { recursive: true, force: true });
    NodeFS.cpSync(payloads[index]!, destination, { recursive: true, verbatimSymlinks: true });
  });
  return true;
}

/** Publish only complete snapshots; never hard-link dependencies that packaging will mutate. */
export function saveCache(entry: string, sources: readonly string[]): void {
  NodeFS.mkdirSync(NodePath.dirname(entry), { recursive: true });
  const temporary = NodeFS.mkdtempSync(`${entry}.tmp-`);
  try {
    const payloads = sources.map((source, index) => {
      const destination = NodePath.join(temporary, String(index));
      NodeFS.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
      return destination;
    });
    NodeFS.writeFileSync(NodePath.join(temporary, "sha256"), fingerprintPaths(payloads));
    NodeFS.rmSync(entry, { recursive: true, force: true });
    NodeFS.renameSync(temporary, entry);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Keep a short history so alternating revisions stay fast without unbounded disk growth. */
export function pruneCache(cacheRoot: string, keep = 2, requiredEntry?: string): void {
  if (!NodeFS.existsSync(cacheRoot)) return;
  const children = NodeFS.readdirSync(cacheRoot, { withFileTypes: true });
  for (const child of children.filter(
    (entry) => entry.isDirectory() && entry.name.includes(".tmp-"),
  )) {
    NodeFS.rmSync(NodePath.join(cacheRoot, child.name), { recursive: true, force: true });
  }
  const entries = children
    .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-"))
    .map((entry) => {
      const path = NodePath.join(cacheRoot, entry.name);
      return { path, modified: NodeFS.statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  const retained = entries.filter((entry) => entry.path === requiredEntry);
  const candidates = entries.filter((entry) => entry.path !== requiredEntry);
  for (const entry of candidates.slice(Math.max(0, keep - retained.length))) {
    NodeFS.rmSync(entry.path, { recursive: true, force: true });
  }
}
