import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as React from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  dispatch: (_action: unknown) => {},
  getState: (): unknown => undefined,
  getRoute: (): unknown => undefined,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useWorkspacePaneState: () => ({ fileInspector: { supported: true } }),
}));
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return {
    StackActions: requireNavigation("@react-navigation/routers").StackActions,
    useNavigation: () => ({ dispatch: harness.dispatch, getState: harness.getState }),
    useRoute: () => harness.getRoute(),
  };
});

import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions } = requireNavigation("@react-navigation/routers") as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

function setup(fromAgents: boolean, fullscreen = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const router = StackRouter({});
  const options = {
    routeNames: ["Home", "Thread", "ThreadAgents", "ThreadInspectorFullscreen"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  harness.dispatch = (action) => dispatch(action as Parameters<typeof dispatch>[0]);
  harness.getState = () => state;
  harness.getRoute = () => state.routes.at(-1);
  const source = { environmentId: "remote-environment", threadId: "parent" };
  dispatch(StackActions.push("Thread", { ...source, prompt: "retained prompt" }));
  const parentKey = state.routes.at(-1)!.key;
  if (fullscreen)
    dispatch(StackActions.push("ThreadInspectorFullscreen", { ...source, threadId: "child" }));
  if (fromAgents)
    dispatch(
      StackActions.push("ThreadAgents", fullscreen ? { ...source, threadId: "child" } : source),
    );
  let openInspector: ReturnType<typeof useOpenThreadInspector>;
  let openLinkedThread: ReturnType<typeof useOpenLinkedThread>;
  function Probe() {
    const open = useOpenThreadInspector();
    const openLinked = useOpenLinkedThread();
    useLayoutEffect(() => {
      openInspector = open;
      openLinkedThread = openLinked;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  return {
    source,
    parentKey,
    dispatch,
    get state() {
      return state;
    },
    open(target: Parameters<typeof openInspector>[1], from = source) {
      let opened = false;
      act(() => {
        opened = openInspector(from, target);
      });
      return opened;
    },
    openLinked(threadId: string) {
      act(() => openLinkedThread({ environmentId: source.environmentId, threadId }));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("opens a subagent from the Agents sheet without replacing the parent thread", () => {
  using screen = setup(true);
  const inspector = {
    type: "thread",
    environmentId: screen.source.environmentId,
    threadId: "child",
  } as const;
  screen.open(inspector);
  expect(screen.state.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, prompt: "retained prompt", inspector },
  });
  screen.dispatch(StackActions.push("ThreadInspectorFullscreen", inspector));
  screen.dispatch(StackActions.pop());
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it("opens a completion link in the parent inspector", () => {
  using screen = setup(false);
  screen.openLinked("child");
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: {
      ...screen.source,
      inspector: { type: "thread", environmentId: screen.source.environmentId, threadId: "child" },
    },
  });
});

it("switches between subagents and devices in the same parent route", () => {
  using screen = setup(false);
  screen.open({ type: "thread", environmentId: screen.source.environmentId, threadId: "child" });
  const inspector = { type: "device", ...screen.source } as const;
  screen.open(inspector);
  expect(screen.state.routes).toHaveLength(2);
  expect(screen.state.routes.at(-1)).toMatchObject({
    key: screen.parentKey,
    params: { ...screen.source, inspector },
  });
});

it.each(["thread", "device"] as const)(
  "keeps the parent when a maximized child opens a %s preview",
  (type) => {
    using screen = setup(false, true);
    const child = { ...screen.source, threadId: "child" };
    const originalState = screen.state;
    expect(screen.open({ type, ...child, threadId: "grandchild" }, child)).toBe(false);
    expect(screen.state).toEqual(originalState);
    screen.dispatch(StackActions.pop());
    expect(screen.state.routes.at(-1)).toMatchObject({
      key: screen.parentKey,
      params: screen.source,
    });
  },
);

it("keeps the parent when the maximized child's Agents sheet opens another child", () => {
  using screen = setup(true, true);
  const child = { ...screen.source, threadId: "child" };
  const originalState = screen.state;
  expect(screen.open({ type: "thread", ...child, threadId: "grandchild" }, child)).toBe(false);
  expect(screen.state).toEqual(originalState);
});

it("registers a focused inspector once per layout and keeps its panes current", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requireMobile = NodeModule.createRequire(import.meta.url);
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  interface Registered {
    readonly active: string;
    readonly resetKeys?: ReadonlyArray<unknown>;
    readonly panes: ReadonlyArray<{ readonly key: string; readonly render: () => React.ReactNode }>;
  }
  const deactivate = vi.fn();
  type Register = (
    content: Registered,
    routeKey: string | undefined,
    revealKey?: string,
  ) => () => void;
  const register = vi.fn<Register>(() => deactivate);
  const layoutContext = React.createContext<{ readonly registerWorkspaceInspector: Register }>({
    registerWorkspaceInspector: register,
  });
  // Like the workspace layout without compiler memoization: each registration is a new state
  // object and a new context value. The cap ends a registration loop so the count can fail.
  function Layout(props: { readonly children: React.ReactNode }) {
    const [registered, setRegistered] = React.useState<{ readonly content: Registered } | null>(
      null,
    );
    const registerWorkspaceInspector: Register = (content, routeKey, revealKey) => {
      register(content, routeKey, revealKey);
      if (register.mock.calls.length <= 20) setRegistered({ content });
      return () => {
        deactivate();
        setRegistered(null);
      };
    };
    return (
      <layoutContext.Provider value={{ registerWorkspaceInspector }}>
        {props.children}
        <div data-testid="column">
          {registered?.content.panes.map((pane) => (
            <div key={pane.key}>{pane.render()}</div>
          ))}
        </div>
      </layoutContext.Provider>
    );
  }
  const navigation = {
    isFocused: () => focused,
    addListener(event: "focus" | "blur", listener: () => void) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
  };
  const navigationContext = React.createContext(navigation);
  const routeContext = React.createContext<{ readonly key: string; readonly param?: string }>({
    key: "file",
  });
  const babel = requireMobile("@babel/core") as {
    transformFileSync(file: string, options: Record<string, unknown>): { code: string };
  };
  const compiled = babel.transformFileSync(
    NodePath.resolve(__dirname, "../layout/AdaptiveWorkspaceLayout.tsx"),
    {
      babelrc: false,
      configFile: false,
      presets: [
        [
          requireMobile.resolve("babel-preset-expo"),
          { unstable_transformImportMeta: true, enableBabelRuntime: false },
        ],
      ],
      caller: {
        name: "metro",
        bundler: "metro",
        platform: "ios",
        isDev: false,
        isServer: false,
        isNodeModule: false,
        supportsStaticESM: false,
        supportsReactCompiler: true,
      },
    },
  );
  const exports: {
    Inspector?: (props: { readonly content: Registered; readonly revealKey?: string }) => null;
  } = {};
  const load = (name: string) => {
    if (name === "react" || name.startsWith("react/")) return requireMobile(name);
    if (name === "./adaptive-workspace-context")
      return { useAdaptiveWorkspaceLayout: () => React.use(layoutContext) };
    if (name === "@react-navigation/native")
      return {
        NavigationContext: navigationContext,
        NavigationRouteContext: routeContext,
      };
    return {};
  };
  new Function("require", "exports", compiled.code)(load, exports);
  const Inspector = exports.Inspector!;
  interface Spec {
    readonly label: string;
    readonly active?: string;
    readonly keys?: ReadonlyArray<string>;
    readonly resetKeys?: ReadonlyArray<unknown>;
    readonly revealKey?: string;
    readonly routeParam?: string;
  }
  // A screen that reads the layout and builds its inspector content anew on every render.
  function Screen({ spec }: { spec: Spec | undefined }) {
    React.use(layoutContext);
    if (spec === undefined) return null;
    const RouteParam = () => React.use(routeContext).param ?? "";
    return (
      <routeContext.Provider value={{ key: "file", param: spec.routeParam }}>
        <ScreenInspector spec={spec} RouteParam={RouteParam} />
      </routeContext.Provider>
    );
  }
  function ScreenInspector({ spec, RouteParam }: { spec: Spec; RouteParam: () => string }) {
    return (
      <Inspector
        revealKey={spec.revealKey}
        content={{
          active: spec.active ?? "main",
          resetKeys: spec.resetKeys ?? ["thread"],
          panes: (spec.keys ?? ["main"]).map((key) => ({
            key,
            render: () => (
              <>
                {key}:{spec.label}
                <RouteParam />{" "}
              </>
            ),
          })),
        }}
      />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const render = (spec: Spec | undefined) =>
    act(() =>
      root.render(
        <Layout>
          <Screen spec={spec} />
        </Layout>,
      ),
    );
  const column = () => container.querySelector("[data-testid=column]")?.textContent;
  const registrations = () => register.mock.calls.length;

  render({ label: "first" });
  expect(registrations()).toBe(1);
  expect(column()).toBe("main:first ");
  render({ label: "first" });
  expect(registrations()).toBe(1);
  render({ label: "second" });
  expect(registrations()).toBe(1);
  expect(column()).toBe("main:second ");
  render({ label: "second", routeParam: "?params" });
  expect(registrations()).toBe(1);
  expect(column()).toBe("main:second?params ");

  const changes: ReadonlyArray<readonly [string, Spec, string]> = [
    ["panes", { label: "a", keys: ["main", "git"] }, "main:a git:a "],
    ["active pane", { label: "b", keys: ["main", "git"], active: "git" }, "main:b git:b "],
    ["reset keys", { label: "c", resetKeys: ["other thread"] }, "main:c "],
    ["reveal key", { label: "d", resetKeys: ["other thread"], revealKey: "reveal" }, "main:d "],
  ];
  for (const [change, spec, shown] of changes) {
    const before = registrations();
    render(spec);
    render({ ...spec });
    expect(registrations(), change).toBe(before + 1);
    expect(column(), change).toBe(shown);
    const [content, routeKey, revealKey] = register.mock.lastCall!;
    expect(
      {
        active: content.active,
        keys: content.panes.map((pane) => pane.key),
        resetKeys: content.resetKeys,
        routeKey,
        revealKey,
      },
      change,
    ).toEqual({
      active: spec.active ?? "main",
      keys: spec.keys ?? ["main"],
      resetKeys: ["file", ...(spec.resetKeys ?? ["thread"])],
      routeKey: "file",
      revealKey: spec.revealKey,
    });
  }

  const emit = (event: "focus" | "blur") =>
    act(() => {
      focused = event === "focus";
      for (const listener of listeners[event]) listener();
    });
  const last = changes.at(-1)![1];
  const beforeBlur = registrations();
  emit("blur");
  expect(deactivate).toHaveBeenCalledTimes(1);
  expect(column()).toBe("");
  render({ ...last, label: "blurred" });
  expect(registrations()).toBe(beforeBlur);
  emit("focus");
  expect(registrations()).toBe(beforeBlur + 1);
  expect(column()).toBe("main:blurred ");
  emit("focus");
  expect(registrations()).toBe(beforeBlur + 1);
  render(undefined);
  expect(deactivate).toHaveBeenCalledTimes(2);
  expect(column()).toBe("");
  render(last);
  expect(registrations()).toBe(beforeBlur + 2);
  expect(column()).toBe("main:d ");
  act(() => root.unmount());
  expect(deactivate).toHaveBeenCalledTimes(3);
  expect(listeners.focus.size + listeners.blur.size).toBe(0);
});
