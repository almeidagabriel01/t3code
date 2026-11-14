import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    value: undefined as unknown,
    session: null as ReadonlyArray<string> | null,
    save: vi.fn(),
    setSession: vi.fn(),
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === sessionAtom.current ? mocks.session : mocks.value),
  useAtomSet: (atom: unknown) => (atom === sessionAtom.current ? mocks.setSession : mocks.save),
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));

import { sessionExpandedGroupsAtom, useHomeSectionPreferences } from "./useHomeSectionPreferences";

const sessionAtom = { current: sessionExpandedGroupsAtom as unknown };

function read(value: unknown, session: ReadonlyArray<string> | null = null) {
  mocks.value = value;
  mocks.session = session;
  mocks.save.mockReset();
  mocks.setSession.mockReset();
  let result!: ReturnType<typeof useHomeSectionPreferences>;
  const Probe = () => {
    result = useHomeSectionPreferences();
    return null;
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => createRoot(window.document.createElement("div")).render(<Probe />));
  return result;
}

describe("useHomeSectionPreferences", () => {
  it("defaults to Teams open and ignores toggles before load", () => {
    const prefs = read(AsyncResult.success({}));
    expect(prefs.assistantsCollapsed).toBe(false);
    const waiting = read(AsyncResult.initial());
    waiting.toggleAssistants();
    waiting.toggleAssistantsShowAll();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reads stored values and toggles them through transforms", () => {
    // The removed Agents section's key may still be stored; it is ignored.
    const prefs = read(
      AsyncResult.success({ homeAssistantsCollapsed: true, homeAgentsDoneExpanded: true } as never),
    );
    expect(prefs.assistantsCollapsed).toBe(true);
    expect("agentsDoneExpanded" in prefs).toBe(false);
    prefs.toggleAssistants();
    prefs.toggleAssistantsShowAll();
    const [a, c] = mocks.save.mock.calls.map(
      ([update]) => update.transform as (c: object) => object,
    );
    expect(a!({ homeAssistantsCollapsed: true })).toEqual({ homeAssistantsCollapsed: false });
    expect(a!({})).toEqual({ homeAssistantsCollapsed: true });
    expect(c!({})).toEqual({ homeAssistantsShowAll: true });
    expect(c!({ homeAssistantsShowAll: true })).toEqual({ homeAssistantsShowAll: false });
  });

  it("keeps the fold toggles' identity while the preferences stay the same", () => {
    const value = AsyncResult.success({ homeAssistantsFolded: ["env:bo"] });
    const seen: Array<ReturnType<typeof useHomeSectionPreferences>> = [];
    mocks.value = value;
    mocks.session = null;
    const Probe = (props: { tick: number }) => {
      const prefs = useHomeSectionPreferences();
      useLayoutEffect(() => {
        seen[props.tick] = prefs;
      });
      return null;
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(window.document.createElement("div"));
    act(() => root.render(<Probe tick={0} />));
    act(() => root.render(<Probe tick={1} />));
    expect(seen[1]!.toggleAssistantFolded).toBe(seen[0]!.toggleAssistantFolded);
    expect(seen[1]!.toggleAssistantsGroup).toBe(seen[0]!.toggleAssistantsGroup);
  });

  it("folds and unfolds one assistant by key, keeping the others", () => {
    const prefs = read(AsyncResult.success({ homeAssistantsFolded: ["env:bo"] }));
    expect([...prefs.assistantsFolded]).toEqual(["env:bo"]);
    prefs.toggleAssistantFolded("env:ada");
    const fold = mocks.save.mock.calls[0]![0].transform as (c: object) => object;
    expect(fold({ homeAssistantsFolded: ["env:bo"] })).toEqual({
      homeAssistantsFolded: ["env:bo", "env:ada"],
    });
    expect(fold({ homeAssistantsFolded: ["env:bo", "env:ada"] })).toEqual({
      homeAssistantsFolded: ["env:bo"],
    });
    expect(fold({})).toEqual({ homeAssistantsFolded: ["env:ada"] });
    read(AsyncResult.initial()).toggleAssistantFolded("env:ada");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("opens and closes a group, saving the whole list", () => {
    const prefs = read(AsyncResult.success({ homeAssistantsExpandedGroups: ["group:env:a"] }));
    expect(prefs.assistantsExpandedGroups).toEqual(["group:env:a"]);
    prefs.toggleAssistantsGroup("group:env:b");
    expect(mocks.setSession).toHaveBeenCalledWith(["group:env:a", "group:env:b"]);
    expect(mocks.save).toHaveBeenCalledWith({
      homeAssistantsExpandedGroups: ["group:env:a", "group:env:b"],
    });
    read(AsyncResult.success({})).toggleAssistantsGroup("group:env:a");
    expect(mocks.save).toHaveBeenCalledWith({ homeAssistantsExpandedGroups: ["group:env:a"] });
  });

  it("keeps groups opening for the session while storage cannot load", () => {
    const failed = read(AsyncResult.failure(new Error("storage unavailable") as never));
    expect(failed.assistantsExpandedGroups).toEqual([]);
    failed.toggleAssistantsGroup("group:env:a");
    expect(mocks.setSession).toHaveBeenCalledWith(["group:env:a"]);
    expect(mocks.save).not.toHaveBeenCalled();
    // The session's choice wins over what was stored, so a failed save does not snap it back.
    const later = read(AsyncResult.success({ homeAssistantsExpandedGroups: ["group:env:b"] }), [
      "group:env:a",
    ]);
    expect(later.assistantsExpandedGroups).toEqual(["group:env:a"]);
  });
});
