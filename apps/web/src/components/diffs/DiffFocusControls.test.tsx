import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DeferredDiffFiles, DiffFocusMenu } from "./DiffFocusControls";

describe("DiffFocusControls", () => {
  it("describes an active focus from the toolbar", () => {
    const markup = renderToStaticMarkup(
      <DiffFocusMenu
        preferences={{ showTests: false, showGenerated: true }}
        testFileCount={3}
        generatedFileCount={1}
        deferredFileCount={3}
        onTierVisibilityChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Review focus: 3 files deferred"');
  });

  it("renders one explicit row for each deferred category", () => {
    const markup = renderToStaticMarkup(
      <DeferredDiffFiles
        categories={[
          {
            tier: "test",
            files: [{ name: "app.test.ts" } as never],
            lineStat: { additions: 4, deletions: 1 },
          },
          {
            tier: "generated",
            files: [{ name: "pnpm-lock.yaml" } as never],
            lineStat: { additions: 8, deletions: 2 },
          },
        ]}
        onShow={() => undefined}
      />,
    );

    expect(markup).toContain("Tests · 1 file deferred");
    expect(markup).toContain("Generated · 1 file deferred");
    expect(markup.match(/>Show</g)).toHaveLength(2);
  });
});
