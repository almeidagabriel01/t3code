import { create } from "zustand";

/** The note open in each thread's Notes panel, so it survives tab switches and can be set from outside. */
export const useNotesPanelStore = create<{
  pathByThreadKey: Record<string, string | undefined>;
  setPath: (threadKey: string, path: string | undefined) => void;
}>((set) => ({
  pathByThreadKey: {},
  setPath: (threadKey, path) =>
    set((state) => ({ pathByThreadKey: { ...state.pathByThreadKey, [threadKey]: path } })),
}));
