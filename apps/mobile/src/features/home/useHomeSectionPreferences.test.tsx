import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { value: undefined as unknown, save: vi.fn() },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.value,
  useAtomSet: () => mocks.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));

import { useHomeSectionPreferences } from "./useHomeSectionPreferences";

function read(value: unknown) {
  mocks.value = value;
  mocks.save.mockReset();
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
  it("defaults to assistants open and Done closed, and ignores toggles before load", () => {
    const prefs = read(AsyncResult.success({}));
    expect([prefs.assistantsCollapsed, prefs.agentsDoneExpanded]).toEqual([false, false]);
    const waiting = read(AsyncResult.initial());
    waiting.toggleAssistants();
    waiting.toggleAgentsDone();
    waiting.toggleAssistantsShowAll();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reads stored values and toggles them through transforms", () => {
    const prefs = read(
      AsyncResult.success({ homeAssistantsCollapsed: true, homeAgentsDoneExpanded: true }),
    );
    expect([prefs.assistantsCollapsed, prefs.agentsDoneExpanded]).toEqual([true, true]);
    prefs.toggleAssistants();
    prefs.toggleAgentsDone();
    prefs.toggleAssistantsShowAll();
    const [a, b, c] = mocks.save.mock.calls.map(
      ([update]) => update.transform as (c: object) => object,
    );
    expect(a!({ homeAssistantsCollapsed: true })).toEqual({ homeAssistantsCollapsed: false });
    expect(a!({})).toEqual({ homeAssistantsCollapsed: true });
    expect(b!({})).toEqual({ homeAgentsDoneExpanded: true });
    expect(b!({ homeAgentsDoneExpanded: true })).toEqual({ homeAgentsDoneExpanded: false });
    expect(c!({})).toEqual({ homeAssistantsShowAll: true });
    expect(c!({ homeAssistantsShowAll: true })).toEqual({ homeAssistantsShowAll: false });
  });
});
