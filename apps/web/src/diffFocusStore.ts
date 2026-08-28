import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DiffFocusableTier, DiffFocusPreferences } from "./lib/diffFileFocus";
import { resolveStorage } from "./lib/storage";

const DEFAULT_DIFF_FOCUS_PREFERENCES: DiffFocusPreferences = {
  showTests: true,
  showGenerated: true,
};

interface DiffFocusStoreState {
  preferences: DiffFocusPreferences;
  setTierVisible: (tier: DiffFocusableTier, visible: boolean) => void;
}

export const useDiffFocusStore = create<DiffFocusStoreState>()(
  persist(
    (set) => ({
      preferences: DEFAULT_DIFF_FOCUS_PREFERENCES,
      setTierVisible: (tier, visible) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [tier === "test" ? "showTests" : "showGenerated"]: visible,
          },
        })),
    }),
    {
      name: "t3code:diff-focus:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ preferences: state.preferences }),
    },
  ),
);
