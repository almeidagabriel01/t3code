import type { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ focused: true, dispatch: vi.fn() }));

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string, params: unknown) => ({ name, params }) },
  useNavigation: () => ({ isFocused: () => mocks.focused, dispatch: mocks.dispatch }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "draft-1" }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "env", id: "project-1" }],
}));

import { useUnavailableThreadDraftRedirect } from "./useUnavailableThreadDraftRedirect";

function Probe() {
  useUnavailableThreadDraftRedirect("env" as EnvironmentId);
  return null;
}

function mount(focused: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.focused = focused;
  mocks.dispatch.mockReset();
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("opens a draft in the environment's project when the focused thread is unavailable", () => {
  using _screen = mount(true);
  expect(mocks.dispatch).toHaveBeenCalledWith({
    name: "Thread",
    params: { draft: { requestId: "draft-1", environmentId: "env", projectId: "project-1" } },
  });
});

it("leaves the stack alone when the screen is already being replaced", () => {
  using _screen = mount(false);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
