import { RegistryContext } from "@effect/atom-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    state: null as unknown,
    environmentIds: ["hub"] as string[],
    navigate: vi.fn(),
    alert: vi.fn(),
    authSession: vi.fn(),
    openBrowser: vi.fn(),
    dismissAuthSession: vi.fn(),
    actions: {} as Record<string, ReturnType<typeof vi.fn>>,
    assistants: [] as unknown[],
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: (props: { children?: ReactNode; accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  ),
  Keyboard: { dismiss: vi.fn() },
}));
vi.mock("react-native-svg", () => ({ default: Children, Path: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "t3code" } } }));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (...args: unknown[]) => mocks.authSession(...args),
  openBrowserAsync: (...args: unknown[]) => mocks.openBrowser(...args),
  dismissAuthSession: () => mocks.dismissAuthSession(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, goBack: vi.fn() }),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <p>loading</p>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: { label: string; selected?: boolean; onPress: () => void }) => (
    <button
      aria-label={`chip:${props.label}`}
      aria-pressed={props.selected}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; trailing?: ReactNode; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.title}
      {props.trailing}
      {props.children}
    </section>
  ),
}));
vi.mock("../../components/ui/RowMenuButton", () => ({
  RowMenuButton: (props: {
    label: string;
    actions: Array<{ id: string; title: string }>;
    onAction: (id: string) => void;
  }) => (
    <>
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`${props.label}:${action.title}`}
          onClick={() => props.onAction(action.id)}
        />
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={`open:${props.accessibilityLabel}`} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Toast", () => ({
  Toast: (props: { message: string; action: { label: string; onPress: () => void } }) => (
    <div role="status">
      {props.message}
      <button onClick={props.action.onPress}>{props.action.label}</button>
    </div>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("../../lib/attachmentUpload", () => ({
  waitForEnvironmentConnection: async () => "https://box.tail.ts.net",
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.assistants }),
}));
vi.mock("../../state/integrations", () => ({
  useIntegrationsEnvironmentIds: () => mocks.environmentIds,
  useIntegrationsState: () => mocks.state,
  useIntegrationActions: () => ({ canAct: true, ...mocks.actions }),
}));
vi.mock("../settings/components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({}),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    search: { value: string; placeholder: string; onChangeText: (value: string) => void };
    children?: ReactNode;
  }) => (
    <>
      <input
        aria-label={props.search.placeholder}
        value={props.search.value}
        onChange={(event) => props.search.onChangeText(event.target.value)}
      />
      {props.children}
    </>
  ),
}));
vi.mock("../settings/settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [
      { environmentId: "hub", label: "Hub" },
      { environmentId: "other", label: "Other box" },
    ],
  }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { pendingFlowsAtom } from "./connectFlow";
import { connectedNoticeAtom } from "./useIntegrationFlows";
import { SettingsIntegrationsRouteScreen } from "./SettingsIntegrationsRouteScreen";

const entry = (
  id: string,
  name: string,
  category: string,
  auth: object = { kind: "oauth", registration: "dynamic" },
) => ({
  id,
  name,
  category,
  description: `${name} tools`,
  docsUrl: "https://docs.example",
  server: { transport: "http", url: `https://${id}.example/mcp` },
  auth,
  match: { urls: [], packages: [], names: [] },
});
const detected = (extra: object) => ({
  id: "d-notion",
  name: "notion",
  origin: "claude-code",
  scope: "user",
  catalogId: "notion",
  transport: "http",
  url: "https://notion.example/mcp",
  enabled: true,
  copyable: true,
  secretKeys: ["Authorization"],
  needsValue: ["API_KEY"],
  ...extra,
});
const baseState = () => ({
  catalog: [
    entry("linear", "Linear", "tasks"),
    entry("notion", "Notion", "docs"),
    entry("gmail", "Gmail", "email", {
      kind: "oauth",
      registration: "own-app",
      clientGroup: "google",
    }),
    entry("github", "GitHub", "dev", {
      kind: "token",
      header: "Authorization",
      format: "Bearer {token}",
    }),
  ],
  integrations: [
    {
      name: "linear",
      catalogId: "linear",
      auth: "oauth",
      status: "connected",
      availability: "all",
    },
  ],
  ownApps: [],
  loopbackRedirectUri: "http://127.0.0.1:9/integrations/callback",
  detected: [
    detected({}),
    detected({
      id: "d-docs",
      name: "docs",
      origin: "t3",
      catalogId: null,
      copyable: false,
      secretKeys: [],
      needsValue: [],
    }),
  ],
  detectionSources: [
    {
      origin: "codex",
      path: "/home/.codex/config.toml",
      status: "unreadable",
      reason: "invalid-format",
    },
    { origin: "claude-ai", status: "not-seen" },
  ],
});

let root: Root;
let container: HTMLDivElement;
const render = (entry?: string) =>
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SettingsIntegrationsRouteScreen
          route={{ params: entry === undefined ? undefined : { entry } }}
        />
      </RegistryContext.Provider>,
    ),
  );
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const press = async (label: string) => {
  await act(async () => button(label).click());
};
const section = (title: string) =>
  container.querySelector(`section[aria-label="${title}"]`)?.textContent ?? "";
const confirmAlert = async (buttonText: string, call = -1) => {
  const buttons = mocks.alert.mock.calls.at(call)?.[2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  await act(async () => buttons.find((item) => item.text === buttonText)?.onPress?.());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.state = baseState();
  mocks.environmentIds = ["hub"];
  mocks.assistants = [
    {
      environmentId: "hub",
      assistant: { id: "a1", name: "Jarvis", integrations: { mode: "all" } },
    },
    {
      environmentId: "hub",
      assistant: { id: "a2", name: "Ops", integrations: { mode: "selected", names: [] } },
    },
  ];
  for (const fn of [
    mocks.navigate,
    mocks.alert,
    mocks.authSession,
    mocks.openBrowser,
    mocks.dismissAuthSession,
  ]) {
    fn.mockReset();
  }
  mocks.actions = {
    beginConnect: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        flowId: "f1",
        name: "notion",
        authorizationUrl: "https://auth.example",
        mode: "server",
        redirectUri: "x",
        expiresAt: 1,
      },
    }),
    completeConnect: vi.fn(),
    cancelConnect: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    disconnect: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    makeAvailable: vi.fn(),
  };
  appAtomRegistry.set(pendingFlowsAtom, new Map());
  appAtomRegistry.set(connectedNoticeAtom, null);
});
afterEach(() => act(() => root.unmount()));

describe("integrations directory", () => {
  it("groups rows, keeps only this capability's environments and shows source notes", () => {
    render();
    expect(container.textContent).not.toContain("Other box");
    expect(section("Connected")).toContain("Linear");
    expect(section("Connected")).toContain("Notion");
    expect(section("Connected")).toContain("Works in Claude assistants");
    expect(section("Available")).toContain("GitHub");
    expect(section("Other")).toContain("Added in T3");
    expect(container.textContent).toContain(
      "Couldn't read /home/.codex/config.toml: Not valid JSON or TOML",
    );
    expect(container.textContent).toContain("Not seen yet (open a Claude conversation)");
  });

  it("filters by search and category", async () => {
    render();
    act(() => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Search integrations"]',
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "git");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).not.toContain("Linear");
    expect(container.textContent).not.toContain("No integrations match your search.");
    await press("chip:Email");
    expect(container.textContent).not.toContain("GitHub");
    expect(container.textContent).toContain("No integrations match your search.");
    expect(container.querySelector('[aria-label="Categories"]')).not.toBeNull();
    expect(button("chip:Email").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a spinner before the first state and a hint when no environment is selected", () => {
    mocks.state = null;
    render();
    expect(container.textContent).toContain("loading");
    act(() => root.unmount());
    root = createRoot(container);
    mocks.environmentIds = [];
    render();
    expect(container.textContent).toContain("No integrations match your search.");
  });

  it("a link opens the entry's detail once connected, otherwise searches for it", () => {
    render("linear");
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "detail",
      name: "linear",
    });
    act(() => root.unmount());
    root = createRoot(container);
    render("github");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Search integrations"]')!.value,
    ).toBe("GitHub");
    expect(container.textContent).not.toContain("Linear");
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  it("opens the detail, the custom servers page and Added in T3 rows", async () => {
    render();
    await press("open:Linear");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "detail",
      name: "linear",
    });
    await press("Add custom server");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsAgentTools");
    await press("open:docs");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsAgentTools");
  });
});

describe("connect", () => {
  it("signs in through the auth sheet and offers to choose the assistants", async () => {
    mocks.authSession.mockResolvedValue({
      type: "success",
      url: "t3code://integrations/done?result=connected",
    });
    render();
    await press("Connect for other providers Notion");
    expect(mocks.actions.beginConnect).toHaveBeenCalledWith({
      catalogId: "notion",
      client: { kind: "mobile", origin: "https://box.tail.ts.net", returnScheme: "t3code" },
    });
    expect(mocks.authSession).toHaveBeenCalledWith(
      "https://auth.example",
      "t3code://integrations/done",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Choose which assistants use it",
    );
    await press("Assistants");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsAssistants");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("paste mode goes to the paste step, and the row can then cancel the sign-in", async () => {
    mocks.actions.beginConnect!.mockResolvedValue({
      ok: true,
      value: {
        flowId: "f2",
        name: "notion",
        authorizationUrl: "https://auth.example",
        mode: "paste",
        redirectUri: "x",
        expiresAt: 1,
      },
    });
    render();
    await press("Connect for other providers Notion");
    expect(mocks.openBrowser).toHaveBeenCalledWith("https://auth.example");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "paste",
      catalogId: "notion",
      name: "notion",
    });
    const state = baseState();
    mocks.state = {
      ...state,
      integrations: [
        ...state.integrations,
        {
          name: "notion",
          catalogId: "notion",
          auth: "oauth",
          status: "connecting",
          availability: "assistants",
        },
      ],
    };
    render();
    expect(container.textContent).toContain("Waiting for sign-in…");
    await press("Cancel Notion");
    expect(mocks.actions.cancelConnect).toHaveBeenCalledWith("notion");
  });

  it("opens the token and own-app steps instead of signing in, and explains refusals", async () => {
    mocks.actions.beginConnect!.mockResolvedValue({ ok: false, reason: "unreachable" });
    render();
    await press("Connect GitHub");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "token",
      catalogId: "github",
    });
    await press("Connect Gmail");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "own-app",
      catalogId: "gmail",
    });
    mocks.state = { ...baseState(), integrations: [] };
    render();
    await press("Connect Linear");
    expect(mocks.alert).toHaveBeenCalledWith("Linear didn't respond");
    mocks.actions.beginConnect!.mockResolvedValue({ ok: false, reason: "own-app-required" });
    await press("Connect Linear");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "own-app",
      catalogId: "linear",
    });
  });

  it("a sheet closed early cancels the flow", async () => {
    mocks.authSession.mockResolvedValue({ type: "dismiss" });
    render();
    await press("Connect for other providers Notion");
    expect(mocks.actions.cancelConnect).toHaveBeenCalledWith("notion");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  const withNotion = (status: string) => {
    const state = baseState();
    mocks.state = {
      ...state,
      integrations: [
        ...state.integrations,
        { name: "notion", catalogId: "notion", auth: "oauth", status, availability: "all" },
      ],
    };
  };

  it("cancels by name a sign-in another device started", async () => {
    withNotion("connecting");
    render();
    await press("Cancel Notion");
    expect(mocks.actions.cancelConnect).toHaveBeenCalledWith("notion");
  });

  it("closes the auth sheet when the pushed state ends this device's sign-in", async () => {
    const session = Promise.withResolvers<{ type: string }>();
    mocks.authSession.mockReturnValue(session.promise);
    render();
    await press("Connect for other providers Notion");
    withNotion("connecting");
    render();
    expect(mocks.dismissAuthSession).not.toHaveBeenCalled();
    withNotion("connected");
    render();
    expect(mocks.dismissAuthSession).toHaveBeenCalledTimes(1);
    await act(async () => session.resolve({ type: "dismiss" }));
    expect(mocks.actions.cancelConnect).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Choose which assistants use it",
    );
  });
});

describe("row menus", () => {
  it("disconnect confirms with the number of assistants using it", async () => {
    render();
    await press("Linear actions:Disconnect");
    expect(mocks.alert.mock.calls[0]?.slice(0, 2)).toEqual([
      "Disconnect Linear?",
      "Assistants using it: 1",
    ]);
    await confirmAlert("Disconnect");
    expect(mocks.actions.disconnect).toHaveBeenCalledWith("linear");
    mocks.actions.disconnect!.mockResolvedValue({ ok: false, reason: "storage-failed" });
    await press("Linear actions:Disconnect");
    await confirmAlert("Disconnect");
    expect(mocks.alert).toHaveBeenLastCalledWith("Couldn't save on the server");
  });

  it("make available names what is copied, then follows the outcome", async () => {
    mocks.actions.makeAvailable!.mockResolvedValue({
      ok: true,
      value: { outcome: "copied", name: "notion", leftOut: ["API_KEY"] },
    });
    render();
    await press("Notion actions:Make available to all providers");
    expect(mocks.alert.mock.calls[0]?.slice(0, 2)).toEqual([
      "Make available to all providers",
      "Copies: https://notion.example/mcp\nValues saved as T3 secrets: Authorization\nLeft out (with ${...}): API_KEY",
    ]);
    await confirmAlert("Make available to all providers");
    expect(mocks.actions.makeAvailable).toHaveBeenCalledWith("d-notion");
    expect(mocks.alert).toHaveBeenLastCalledWith("Needs a value", "API_KEY");

    mocks.actions.makeAvailable!.mockResolvedValue({
      ok: true,
      value: { outcome: "connect", catalogId: "notion" },
    });
    mocks.authSession.mockResolvedValue({ type: "cancel" });
    await press("Notion actions:Make available to all providers");
    await confirmAlert("Make available to all providers");
    expect(mocks.actions.beginConnect).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "notion" }),
    );

    mocks.actions.makeAvailable!.mockResolvedValue({ ok: false, reason: "not-copyable" });
    await press("Notion actions:Make available to all providers");
    await confirmAlert("Make available to all providers");
    expect(mocks.alert).toHaveBeenLastCalledWith("This server can't be copied");
  });

  it("use a token instead opens the token step", async () => {
    mocks.state = { ...baseState(), integrations: [] };
    render();
    await press("GitHub actions:Use a token instead");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsIntegration", {
      environmentId: "hub",
      form: "token",
      catalogId: "github",
    });
  });
});
