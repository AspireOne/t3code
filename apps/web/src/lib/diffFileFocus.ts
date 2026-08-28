import type { FileDiffMetadata } from "@pierre/diffs";

import { getDiffLineStat, resolveFileDiffPath, type DiffLineStat } from "./diffRendering";
import { diffFileTier, orderDiffFiles, type DiffFileTier } from "./diffFileOrder";

export type DiffFocusableTier = Exclude<DiffFileTier, "source">;

export interface DiffFocusPreferences {
  readonly showTests: boolean;
  readonly showGenerated: boolean;
}

export interface DeferredDiffCategory {
  readonly tier: DiffFocusableTier;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly lineStat: DiffLineStat;
}

export interface FocusedDiffFiles {
  readonly visibleFiles: ReadonlyArray<FileDiffMetadata>;
  readonly deferredCategories: ReadonlyArray<DeferredDiffCategory>;
  readonly fileCountByTier: Readonly<Record<DiffFileTier, number>>;
}

export type DiffLineStatByPath = ReadonlyMap<string, DiffLineStat>;

function isTierShown(tier: DiffFileTier, preferences: DiffFocusPreferences): boolean {
  if (tier === "source") return true;
  return tier === "test" ? preferences.showTests : preferences.showGenerated;
}

export function focusDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
  preferences: DiffFocusPreferences,
  alwaysVisiblePaths: ReadonlySet<string> = new Set(),
  lineStatByPath?: DiffLineStatByPath,
): FocusedDiffFiles {
  return focusOrderedDiffFiles(
    orderDiffFiles(files),
    preferences,
    alwaysVisiblePaths,
    lineStatByPath,
  );
}

export function focusOrderedDiffFiles(
  orderedFiles: ReadonlyArray<FileDiffMetadata>,
  preferences: DiffFocusPreferences,
  alwaysVisiblePaths: ReadonlySet<string> = new Set(),
  lineStatByPath?: DiffLineStatByPath,
): FocusedDiffFiles {
  const fileCountByTier: Record<DiffFileTier, number> = {
    source: 0,
    test: 0,
    generated: 0,
  };
  const deferredByTier: Record<DiffFocusableTier, FileDiffMetadata[]> = {
    test: [],
    generated: [],
  };
  const visibleFiles: FileDiffMetadata[] = [];

  for (const file of orderedFiles) {
    const path = resolveFileDiffPath(file);
    const tier = diffFileTier(path);
    fileCountByTier[tier] += 1;
    if (isTierShown(tier, preferences) || alwaysVisiblePaths.has(path)) {
      visibleFiles.push(file);
    } else if (tier !== "source") {
      deferredByTier[tier].push(file);
    }
  }

  const deferredCategories = (["test", "generated"] as const).flatMap((tier) => {
    const deferredFiles = deferredByTier[tier];
    const lineStat = deferredFiles.reduce<DiffLineStat>(
      (total, file) => {
        const path = resolveFileDiffPath(file);
        const parsed = getDiffLineStat([file]);
        const resolved =
          parsed.additions === 0 && parsed.deletions === 0
            ? (lineStatByPath?.get(path) ?? parsed)
            : parsed;
        return {
          additions: total.additions + resolved.additions,
          deletions: total.deletions + resolved.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    );
    return deferredFiles.length === 0 ? [] : [{ tier, files: deferredFiles, lineStat }];
  });

  return { visibleFiles, deferredCategories, fileCountByTier };
}
