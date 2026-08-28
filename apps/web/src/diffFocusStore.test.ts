import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useDiffFocusStore } from "./diffFocusStore";

describe("diffFocusStore", () => {
  beforeEach(() =>
    useDiffFocusStore.setState({
      preferences: { showTests: true, showGenerated: true },
    }),
  );

  it("persists independent test and generated preferences", async () => {
    useDiffFocusStore.getState().setTierVisible("test", false);

    expect(useDiffFocusStore.getState().preferences).toEqual({
      showTests: false,
      showGenerated: true,
    });
    const { name, storage } = useDiffFocusStore.persist.getOptions();
    if (!name) throw new Error("Expected diff focus persistence to have a storage name");
    expect((await storage?.getItem(name))?.state).toMatchObject({
      preferences: { showTests: false, showGenerated: true },
    });
  });
});
