import { act, createContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { stubModules } from "../../testing/stubModules";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  deactivate: vi.fn(),
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  return {
    NavigationContext: createContext<unknown>(undefined),
    NavigationRouteContext: createContext<unknown>(undefined),
    useNavigation: () => undefined,
  };
});
vi.mock("./adaptive-workspace-context", () => ({
  AdaptiveWorkspaceContext: createContext(null),
  useAdaptiveWorkspaceLayout: () => ({ registerWorkspaceInspector: mocks.register }),
}));

stubModules(import.meta.dirname, [
  "../../components/RenderErrorBoundary",
  "../../components/ui/Pane",
  "../../components/ui/useAndroidControlSizing",
  "../../components/ui/useToolbarLayout",
  "../../lib/layout",
  "../../lib/root-stack-reset",
  "../../lib/uuid",
  "../../native/AndroidHingeObserver",
  "../../native/native-layout-metrics",
  "../../native/v5-workspace-context",
  "../../native/window-hinge-context",
  "../../persistence/mobile-preferences",
  "../../state/preferences",
  "../../state/project-grouping",
  "../../state/use-thread-pr",
  "../home/home-list-options",
  "../keyboard/hardwareKeyboardCommands",
  "../keyboard/useSoftKeyboardShowing",
  "../settings/SettingsWorkspaceLayout",
  "../settings/appearance/AppearancePreferencesProvider",
  "./deferred-navigation",
  "./workspace-content-width",
  "./workspace-inspector-pane",
  "./workspace-inspector-sheet",
  "./workspace-overlay-routes",
  "./workspace-pane-animation",
  "./workspace-presentation-context",
  "./workspace/AndroidWorkspaceNavigation",
  "./workspace/AndroidWorkspaceTabsProvider",
  "./workspace/WorkspaceTabsContext",
  "./workspace/WorkspaceThreadSidebar",
  "./workspace/floating-workspace-tabs",
  "./workspace/navigation-tabs",
  "./workspace/useSelectWorkspaceDetail",
  "./workspace/workspace-detail-selection",
  "./workspace/workspace-selection-store",
  "./workspace/workspace-tab-navigation",
  "@effect/atom-react",
  "effect/reactivity",
  "react-native",
  "react-native-keyboard-controller",
  "react-native-reanimated",
  "react-native-safe-area-context",
]);
const { Inspector } = await import("./AdaptiveWorkspaceLayout");
const { NavigationContext, NavigationRouteContext } = await import("@react-navigation/native");

type Pane = { key: string; prewarm?: boolean; render: () => ReactNode };
type Content = { active: string; panes: Pane[]; resetKeys?: unknown[] };

function createNavigation() {
  const listeners = new Map<string, () => void>();
  return {
    isFocused: () => true,
    addListener: (event: string, listener: () => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    emit: (event: string) => listeners.get(event)?.(),
  };
}

function mount() {
  const navigation = createNavigation();
  const route = { key: "route-1" };
  const root = createRoot(document.createElement("div"));
  const show = (content: Content, revealKey?: string) =>
    act(() =>
      root.render(
        <NavigationContext.Provider value={navigation as never}>
          <NavigationRouteContext.Provider value={route as never}>
            <Inspector content={content as never} revealKey={revealKey} />
          </NavigationRouteContext.Provider>
        </NavigationContext.Provider>,
      ),
    );
  const registered = () => mocks.register.mock.calls.at(-1)?.[0] as Content;
  const paneHost = document.createElement("div");
  const paneRoot = createRoot(paneHost);
  return {
    navigation,
    show,
    registered,
    paneHost,
    renderPane: (key: string) =>
      act(() =>
        paneRoot.render(
          registered()
            .panes.find((pane) => pane.key === key)
            ?.render(),
        ),
      ),
    [Symbol.dispose]: () => {
      act(() => paneRoot.unmount());
      act(() => root.unmount());
    },
  };
}

const content = (label: string, active = "files"): Content => ({
  active,
  panes: [
    { key: "files", render: () => <b>{label}</b> },
    { key: "git", prewarm: true, render: () => <i>git</i> },
  ],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.register.mockReset();
  mocks.deactivate.mockReset();
  mocks.register.mockReturnValue(mocks.deactivate);
});

it("registers once on focus and keeps its mounted pane current without registering again", () => {
  using view = mount();
  view.show(content("first"), "reveal");
  expect(mocks.register).toHaveBeenCalledOnce();
  expect(mocks.register.mock.calls[0]?.[1]).toBe("route-1");
  expect(mocks.register.mock.calls[0]?.[2]).toBe("reveal");
  view.renderPane("files");
  expect(view.paneHost.textContent).toBe("first");

  view.show(content("second"), "reveal");
  expect(mocks.register).toHaveBeenCalledOnce();
  expect(view.paneHost.textContent).toBe("second");
});

it("registers again when the layout or the reveal key changes", () => {
  using view = mount();
  view.show(content("a"));
  view.show(content("a", "git"));
  expect(mocks.register).toHaveBeenCalledTimes(2);
  view.show(content("a", "git"), "new-key");
  expect(mocks.register).toHaveBeenCalledTimes(3);
  view.show({ ...content("a", "git"), resetKeys: ["x"] }, "new-key");
  expect(mocks.register).toHaveBeenCalledTimes(4);
  view.show({ ...content("a", "git"), panes: content("a").panes.slice(0, 1) }, "new-key");
  expect(mocks.register).toHaveBeenCalledTimes(5);
});

it("releases the inspector on blur and registers again when focused", () => {
  using view = mount();
  view.show(content("a"));
  act(() => view.navigation.emit("blur"));
  expect(mocks.deactivate).toHaveBeenCalledOnce();
  act(() => view.navigation.emit("focus"));
  expect(mocks.register).toHaveBeenCalledTimes(2);
  view.show(content("b"));
  expect(mocks.register).toHaveBeenCalledTimes(2);
});
