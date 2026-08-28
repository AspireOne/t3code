import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { focusDiffFiles } from "./diffFileFocus";

function file(name: string, additions = 0, deletions = 0): FileDiffMetadata {
  return {
    name,
    additionLines: [],
    deletionLines: [],
    hunks:
      additions === 0 && deletions === 0
        ? []
        : [{ additionLines: additions, deletionLines: deletions }],
  } as unknown as FileDiffMetadata;
}

describe("focusDiffFiles", () => {
  const files = [file("src/app.test.ts", 3, 1), file("pnpm-lock.yaml", 5), file("src/app.ts", 2)];

  it("shows every file by default in review order", () => {
    const result = focusDiffFiles(files, { showTests: true, showGenerated: true });

    expect(result.visibleFiles.map((entry) => entry.name)).toEqual([
      "src/app.ts",
      "src/app.test.ts",
      "pnpm-lock.yaml",
    ]);
    expect(result.deferredCategories).toEqual([]);
    expect(result.fileCountByTier).toEqual({ source: 1, test: 1, generated: 1 });
  });

  it("defers test and generated files independently with their statistics", () => {
    const result = focusDiffFiles(files, { showTests: false, showGenerated: true });

    expect(result.visibleFiles.map((entry) => entry.name)).toEqual([
      "src/app.ts",
      "pnpm-lock.yaml",
    ]);
    expect(result.deferredCategories).toMatchObject([
      { tier: "test", lineStat: { additions: 3, deletions: 1 } },
    ]);
  });

  it("keeps an actionable file visible without revealing its category", () => {
    const result = focusDiffFiles(
      files,
      { showTests: false, showGenerated: false },
      new Set(["src/app.test.ts"]),
    );

    expect(result.visibleFiles.map((entry) => entry.name)).toEqual([
      "src/app.ts",
      "src/app.test.ts",
    ]);
    expect(result.deferredCategories.map((category) => category.tier)).toEqual(["generated"]);
  });

  it("uses host-reported statistics when a deferred patch withheld its hunks", () => {
    const result = focusDiffFiles(
      [file("src/app.ts"), file("src/app.test.ts")],
      { showTests: false, showGenerated: true },
      new Set(),
      new Map([["src/app.test.ts", { additions: 12, deletions: 4 }]]),
    );

    expect(result.deferredCategories[0]?.lineStat).toEqual({ additions: 12, deletions: 4 });
  });
});
