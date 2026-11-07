import {
  ASSISTANT_STANDUP_PROMPT_HEAD,
  DEFAULT_ASSISTANT_AUTONOMY,
  DEFAULT_AUTONOMY_SETTINGS,
  type Assistant,
} from "@t3tools/contracts";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    spend: null as unknown,
    update: vi.fn(),
    entries: [] as unknown[],
    tasks: [] as Array<{ threadId: string | null; prompt: string }>,
    sandbox: null as unknown,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => null },
}));
vi.mock("react-native", () => ({
  View: Children,
  Platform: { OS: "android" },
  Pressable: Children,
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-svg", () => ({ default: Children, Path: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: () => null }));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn(), dispatch: vi.fn(), navigate: vi.fn() }),
  usePreventRemove: () => undefined,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; accessory?: ReactNode }) => (
    <>
      {props.label}
      {props.description}
      {props.accessory}
    </>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      checked={props.value}
      onChange={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../layout/native-glass-header-items", () => ({ withNativeGlassHeaderItem: vi.fn() }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../../state/assistants", () => ({
  useAssistantActions: () => ({ canAct: true, update: mocks.update, create: vi.fn() }),
  useAssistantEntries: () => ({ active: mocks.entries, archived: [] }),
  useAssistantSpend: () => ({ data: mocks.spend }),
  useAssistantSandbox: () => mocks.sandbox,
  useAssistantsEnvironmentIds: () => ["hub"],
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("./AssistantSchedulesSection", () => ({ AssistantSchedulesSection: () => null }));
vi.mock("./AssistantWatchesSection", () => ({
  AssistantWatchesSection: (props: { notifies: boolean }) => (
    <p data-watches>{props.notifies ? "notifies" : "silent"}</p>
  ),
}));
vi.mock("./useAssistantFlows", () => ({ useAssistantFlows: () => ({ canAct: true }) }));
vi.mock("./useAssistantEditor", async () => {
  const draft = await import("./assistantDraft");
  const { appAtomRegistry } = await import("../../state/atom-registry");
  return {
    assistantProjectName: (project: { title: string }) => project.title,
    useAssistantEditor: () => {
      const editor = useSyncExternalStore(
        (listener) => appAtomRegistry.subscribe(draft.assistantEditorAtom, listener),
        () => appAtomRegistry.get(draft.assistantEditorAtom),
      );
      const project = { id: "p1", title: "Alpha" };
      return {
        editor,
        projects: [project],
        effectiveProject: project,
        modelLabel: "GPT",
        modelSelection: null,
        globalAutonomy: DEFAULT_AUTONOMY_SETTINGS,
      };
    },
  };
});

import { startAssistantEditor } from "./assistantDraft";
import { AssistantEditRouteScreen } from "./AssistantEditRouteScreen";

const assistant = (budget: unknown = null) =>
  ({
    id: "a1",
    name: "Jarvis",
    handle: "jarvis",
    projectId: "p1",
    threadId: "thread-1",
    instructions: "",
    toolAccess: "full",
    askBeforeActing: false,
    workspace: "host",
    icon: null,
    role: "",
    reportsTo: null,
    autonomy: DEFAULT_ASSISTANT_AUTONOMY,
    budget,
    isDefault: false,
    archivedAt: null,
  }) as unknown as Assistant;

let root: Root;
let container: HTMLDivElement;
const render = (target: Assistant) => {
  startAssistantEditor("hub" as never, target);
  act(() => root.render(<AssistantEditRouteScreen />));
};
const pick = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  act(() => found.click());
};
const toggle = (label: string) =>
  act(() => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.click());
const type = (label: string, value: string) =>
  act(() => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.spend = undefined;
  mocks.entries = [];
  mocks.tasks = [];
  mocks.sandbox = null;
  mocks.update.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

describe("assistant workspace", () => {
  it("saves the sandbox when it is chosen, and host when switching back", async () => {
    mocks.sandbox = { state: "running" };
    render(assistant());
    expect(
      container.querySelector('button[aria-label="This Mac"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    pick("Sandbox container (Linux, Docker)");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ workspace: "sandbox" });

    render({ ...assistant(), workspace: "sandbox" } as Assistant);
    pick("This Mac");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[1]?.[0]).toMatchObject({ workspace: "host" });
  });

  it("turns the sandbox off with its reason while Docker is missing", () => {
    mocks.sandbox = { state: "docker_unavailable" };
    render(assistant());
    const option = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sandbox container (Linux, Docker)"]',
    );
    expect(option?.disabled).toBe(true);
    expect(container.textContent).toContain("Docker is not running on that machine.");
  });
});

describe("assistant spending limit", () => {
  it("hides the limit fields until it is switched on, then saves what was entered", async () => {
    render(assistant());
    expect(field("Amount (USD)")).toBeNull();
    toggle("Limit spending");
    expect(field("Warn at (%)")?.value).toBe("80");
    type("Amount (USD)", "5");
    pick("Weekly");
    type("Warn at (%)", "50");
    toggle("Stop when reached");
    expect(
      container.querySelector('button[aria-label="Weekly"]')?.getAttribute("aria-checked"),
    ).toBe("true");

    await act(async () => pick("Save"));
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update.mock.calls[0]?.[0].budget).toMatchObject({
      amountUsd: 5,
      period: "weekly",
      warnAtPercent: 50,
      blockWhenExceeded: false,
    });
  });

  it("shows what was spent, refuses an unusable amount, and switching off clears the limit", async () => {
    mocks.spend = {
      todayUsd: 0,
      periodUsd: 3,
      partial: true,
      budget: { period: "monthly", spentUsd: 2.5 },
    };
    render(
      assistant({
        amountUsd: 10,
        period: "monthly",
        warnAtPercent: 80,
        blockWhenExceeded: true,
        timeZone: "UTC",
      }),
    );
    expect(container.textContent).toContain("At least $2.50 this month");
    expect(field("Amount (USD)")?.value).toBe("10");

    type("Amount (USD)", "0");
    expect(container.textContent).toContain("Enter an amount above zero");
    expect(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!
        .disabled,
    ).toBe(true);

    toggle("Limit spending");
    expect(field("Amount (USD)")).toBeNull();
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].budget).toBeNull();
  });
});

describe("assistant icon", () => {
  it("selects one icon at a time and saves it", async () => {
    render(assistant());
    expect(container.textContent).toContain("Shown instead of its initial.");
    const state = (label: string) =>
      container.querySelector(`button[aria-label="${label}"]`)?.getAttribute("aria-checked");
    expect(state("Initial")).toBe("true");
    pick("Scout");
    expect([state("Scout"), state("Initial")]).toEqual(["true", "false"]);
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].icon).toBe("scout");
  });
});

describe("assistant connectors", () => {
  const withConnectors = () =>
    ({
      ...assistant(),
      mcpServers: [
        {
          name: "docs",
          transport: "http",
          url: "https://docs.example.test/mcp",
          args: [],
          headers: [{ key: "Authorization", hasValue: true }],
          env: [],
          enabled: true,
        },
        {
          name: "files",
          transport: "stdio",
          command: "npx",
          args: ["srv"],
          headers: [],
          env: [],
          enabled: true,
        },
      ],
    }) as unknown as Assistant;

  it("adds an HTTP connector with a header and refuses a bad URL before saving", async () => {
    render(assistant());
    expect(container.textContent).toContain("Connectors work with Claude, Codex, Cursor");
    pick("Add connector");
    type("Connector name", "Docs");
    expect(field("Connector name")?.value).toBe("docs");
    type("URL", "nope");
    pick("Add header");
    type("Header 1", "Authorization");
    type("Header 1 value", "Bearer abc");
    pick("Add");
    expect(container.textContent).toContain('"docs" needs an http or https URL.');
    type("URL", "https://docs.example.test/mcp");
    pick("Add");
    expect(container.textContent).toContain("docs");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].mcpServers).toEqual([
      {
        name: "docs",
        transport: "http",
        url: "https://docs.example.test/mcp",
        headers: [{ key: "Authorization", value: "Bearer abc" }],
        enabled: true,
      },
    ]);
  });

  it("edits a saved connector keeping its secret, toggles it and removes another", async () => {
    render(withConnectors());
    pick("Remove files");
    toggle("docs enabled");
    pick("Edit docs");
    expect(field("Connector name")?.disabled ?? false).toBe(false);
    type("URL", "https://docs.example.test/v2");
    pick("Done");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].mcpServers).toEqual([
      {
        name: "docs",
        transport: "http",
        url: "https://docs.example.test/v2",
        headers: [{ key: "Authorization" }],
        enabled: false,
      },
    ]);
  });

  it("a command connector takes arguments and variables, and cancel discards the form", async () => {
    render(assistant());
    pick("Add connector");
    pick("Command (runs on the server)");
    type("Connector name", "files");
    type("Command", "npx");
    type("Arguments", "-y");
    pick("Add variable");
    type("Variable 1", "TOKEN");
    pick("Remove variable 1");
    pick("Add");
    pick("Add connector");
    type("Connector name", "other");
    pick("Cancel");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].mcpServers).toEqual([
      {
        name: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y"],
        env: [],
        enabled: true,
      },
    ]);
  });
});

describe("assistant ask before acting", () => {
  it("shows its help text and saves the switch only once it changed", async () => {
    render(assistant());
    expect(container.textContent).toContain(
      "Before this assistant sends anything into another conversation, it asks you here and waits for your approval.",
    );
    expect(field("Ask before acting")?.checked).toBe(false);
    toggle("Ask before acting");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].askBeforeActing).toBe(true);
  });
});

describe("assistant notifications", () => {
  const checked = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`)?.getAttribute("aria-checked");

  it("hides the scopes until it notifies, then saves the whole autonomy object", async () => {
    render(assistant());
    expect(container.querySelector("[data-watches]")?.textContent).toBe("silent");
    expect(container.textContent).not.toContain("When to notify");
    pick("Reply and notify me");
    expect(container.querySelector("[data-watches]")?.textContent).toBe("notifies");
    expect(checked("Reply and notify me")).toBe("true");
    expect(container.textContent).toContain("When to notify");

    // Custom lists start from the global rules, projects and channels, then toggle one value.
    pick("Only for these");
    pick("PR checks failed");
    pick("Only these projects");
    pick("Alpha");
    pick("Only on these");
    pick("Telegram");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0].autonomy).toEqual({
      mode: "reply-and-notify",
      rules: ["runFailed", "waitingTooLong", "stuck", "reviewIncomplete"],
      projectIds: [],
      channels: ["t3"],
    });
  });

  it("goes back to inheriting, and a round trip saves nothing", async () => {
    render(assistant());
    pick("Reply and notify me");
    pick("Only for these");
    pick("Same as global");
    pick("Only reply when I message it");
    expect(container.textContent).not.toContain("When to notify");
    expect(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!
        .disabled,
    ).toBe(true);
  });
});

describe("assistant team", () => {
  const entry = (id: string, name: string, extra: object = {}) => ({
    environmentId: "hub",
    assistant: { ...assistant(), id, name, handle: id, ...extra } as Assistant,
  });

  it("saves the role and leader, never offering itself or anyone below it", async () => {
    const me = assistant();
    mocks.entries = [
      entry("a1", "Jarvis"),
      entry("boss", "Boss"),
      entry("kid", "Kid", { reportsTo: "a1" }),
    ];
    render(me);
    type("Role", " Chief ");
    expect(container.querySelector('button[aria-label="menu:Kid"]')).toBeNull();
    expect(container.querySelector('button[aria-label="menu:Jarvis"]')).toBeNull();
    pick("menu:Boss");
    await act(async () => pick("Save"));
    expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ role: "Chief", reportsTo: "boss" });
  });

  it("clears the leader with Nobody and creates under one", async () => {
    mocks.entries = [entry("boss", "Boss")];
    render(assistant());
    pick("menu:Boss");
    pick("menu:Nobody");
    expect(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!
        .disabled,
    ).toBe(true);
  });

  it("offers the standup only to a leader and adds it once", async () => {
    mocks.entries = [entry("a1", "Jarvis"), entry("kid", "Kid", { reportsTo: "a1" })];
    render(assistant());
    await act(async () => pick("Add daily standup"));
    expect(mocks.update).toHaveBeenCalledWith({ assistantId: "a1", addStandup: true });
    expect(container.textContent).toContain("It is in its schedules below");
    expect(container.textContent).not.toContain("Add daily standup");
  });

  it("does not offer a standup the conversation already has, even renamed", () => {
    mocks.entries = [entry("a1", "Jarvis"), entry("kid", "Kid", { reportsTo: "a1" })];
    mocks.tasks = [{ threadId: "thread-1", prompt: `${ASSISTANT_STANDUP_PROMPT_HEAD}\nAsk.` }];
    render(assistant());
    expect(container.textContent).toContain("It is in its schedules below");
    expect(container.textContent).not.toContain("Add daily standup");
  });

  it("shows a refused standup and lets the user retry", async () => {
    mocks.entries = [entry("a1", "Jarvis"), entry("kid", "Kid", { reportsTo: "a1" })];
    mocks.update.mockResolvedValueOnce({ ok: false, message: "Nope." });
    render(assistant());
    await act(async () => pick("Add daily standup"));
    expect(container.textContent).toContain("Nope.");
    await act(async () => pick("Add daily standup"));
    expect(container.textContent).toContain("It is in its schedules below");
  });

  it("has no standup for an assistant without reports", () => {
    mocks.entries = [entry("a1", "Jarvis")];
    render(assistant());
    expect(container.textContent).not.toContain("Add daily standup");
  });
});
