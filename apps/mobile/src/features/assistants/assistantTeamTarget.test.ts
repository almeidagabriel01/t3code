import { describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => store.value,
    set: (_atom: unknown, value: unknown) => {
      store.value = value;
    },
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => () => {},
}));

import { setGroupDefaultEnvironmentDraft, setGroupDefaultModelDraft } from "./assistantTeamTarget";

const opus = { instanceId: "claude", model: "claude-opus-5-5" } as never;

describe("group settings drafts", () => {
  it("keeps the other unsaved draft and drops the scroll section", () => {
    store.value = { environmentId: "hub", teamId: "crew", section: "routines" };
    setGroupDefaultModelDraft(opus);
    setGroupDefaultEnvironmentDraft(null);
    expect(store.value).toEqual({
      environmentId: "hub",
      teamId: "crew",
      defaultModelDraft: opus,
      defaultEnvironmentDraft: null,
    });
    setGroupDefaultModelDraft(null);
    expect(store.value).toMatchObject({ defaultModelDraft: null, defaultEnvironmentDraft: null });
  });

  it("does nothing without an open group", () => {
    store.value = null;
    setGroupDefaultEnvironmentDraft("auto");
    expect(store.value).toBeNull();
  });
});
