// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import { ProjectId, type OrchestrationProject } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly registeredWorkspaceRoots?: ReadonlySet<string>;
}) {
  const makeProject = (workspaceRoot: string): OrchestrationProject => ({
    id: ProjectId.make(`project:${workspaceRoot}`),
    title: "Review project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });

  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            input.registeredWorkspaceRoots?.has(workspaceRoot)
              ? Option.some(makeProject(workspaceRoot))
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeLiveLayer(workspaceRoot: string, baseDir: string) {
  const serverConfigLayer = ServerConfig.layerTest(workspaceRoot, baseDir);
  const vcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const vcsRegistryLayer = VcsDriverRegistry.layer.pipe(
    Layer.provide(vcsProcessLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return ReviewService.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(vcsRegistryLayer),
    Layer.provideMerge(vcsProcessLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("returns working-tree and branch diffs from a nested project cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repositoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-repo-" });
      const projectRoot = NodePath.join(repositoryRoot, "frontend");
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      yield* fs.makeDirectory(projectRoot);

      const result = yield* Effect.gen(function* () {
        const git = yield* GitVcsDriver.GitVcsDriver;
        const runGit = (cwd: string, args: ReadonlyArray<string>) =>
          git.execute({
            operation: "ReviewService.test.git",
            cwd,
            args,
            timeoutMs: 10_000,
          });

        yield* git.initRepo({ cwd: repositoryRoot });
        yield* runGit(repositoryRoot, ["config", "user.email", "test@test.com"]);
        yield* runGit(repositoryRoot, ["config", "user.name", "Test"]);
        yield* runGit(repositoryRoot, ["branch", "-M", "main"]);
        yield* fs.writeFileString(
          NodePath.join(projectRoot, "tracked.ts"),
          "export const v = 1;\n",
        );
        yield* runGit(repositoryRoot, ["add", "."]);
        yield* runGit(repositoryRoot, ["commit", "-m", "initial commit"]);
        yield* runGit(repositoryRoot, ["checkout", "-b", "feature/nested-review"]);
        yield* fs.writeFileString(NodePath.join(projectRoot, "committed.ts"), "export {};\n");
        yield* runGit(repositoryRoot, ["add", "."]);
        yield* runGit(repositoryRoot, ["commit", "-m", "feature commit"]);
        yield* fs.writeFileString(
          NodePath.join(projectRoot, "tracked.ts"),
          "export const v = 2;\n",
        );
        yield* fs.writeFileString(
          NodePath.join(projectRoot, "untracked.ts"),
          "export const u = 1;\n",
        );

        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(Effect.provide(makeLiveLayer(projectRoot, baseDir)));

      const workingTree = result.sources.find((source) => source.kind === "working-tree");
      const branchRange = result.sources.find((source) => source.kind === "branch-range");
      assert.ok(workingTree);
      assert.match(workingTree.diff, /frontend\/tracked\.ts/);
      assert.match(workingTree.diff, /frontend\/untracked\.ts/);
      assert.ok(branchRange);
      assert.strictEqual(branchRange.baseRef, "main");
      assert.match(branchRange.diff, /frontend\/committed\.ts/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must be a registered project or stay within a configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows an active project outside the server process root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            registeredWorkspaceRoots: new Set([projectRoot]),
          }),
        ),
      );

      assert.strictEqual(result.cwd, projectRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must be a registered project or stay within a configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
