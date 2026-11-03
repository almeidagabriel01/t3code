import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), openInspector: vi.fn(() => false) }));

vi.mock("@react-navigation/native", () => ({
  StackActions: {
    replace: (name: string, params: unknown) => ({ type: "replace", name, params }),
    push: (name: string, params: unknown) => ({ type: "push", name, params }),
    pop: () => ({ type: "pop" }),
  },
  useNavigation: () => ({ dispatch: mocks.dispatch, getState: () => undefined }),
  useRoute: () => ({ name: "Thread", params: { environmentId: "env", threadId: "old" } }),
}));
vi.mock("./thread-inspector-navigation", () => ({
  ThreadInspectorNavigationContext: createContext(null),
  useOpenThreadInspector: () => mocks.openInspector,
}));

import { useOpenLinkedThread } from "./useOpenLinkedThread";

function open(options?: { readonly replace?: boolean }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.dispatch.mockReset();
  let run: ReturnType<typeof useOpenLinkedThread> | undefined;
  function Probe() {
    run = useOpenLinkedThread();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  run!({ environmentId: "env", threadId: "new" }, options);
  act(() => root.unmount());
  vi.unstubAllGlobals();
  return mocks.dispatch.mock.calls.map(([action]) => action);
}

it("replaces the current thread when asked, so Back skips it", () => {
  expect(open({ replace: true })).toEqual([
    { type: "replace", name: "Thread", params: { environmentId: "env", threadId: "new" } },
  ]);
});

it("pushes the linked thread otherwise", () => {
  expect(open()).toEqual([
    { type: "push", name: "Thread", params: { environmentId: "env", threadId: "new" } },
  ]);
});
