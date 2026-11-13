import {
  HEAVY_QUEUE_DEFAULTS,
  type EnvironmentId,
  type HeavyCommand,
  type HeavyCommandsState,
  type HeavyQueueEntry,
  type HeavyQueueState,
  type HeavyRunnerLinux,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    state: null as unknown as HeavyQueueState,
    heavy: { commands: [], cpuCount: 8 } as HeavyCommandsState,
    can: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
    alert: vi.fn(),
    selectDetail: vi.fn(),
    titles: {} as Record<string, string>,
    shells: [] as Array<{
      environmentId: string;
      id: string;
      projectId: string;
      title?: string;
      runtime?: { status: string } | null;
    }>,
    host: null as unknown,
    telemetry: null as unknown,
    devices: null as unknown,
    terminals: [] as unknown[],
    focused: true,
    environments: [] as Array<{
      environmentId: string;
      label: string;
      connection: { phase: string };
    }>,
  },
}));

type A11y = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { expanded?: boolean; selected?: boolean };
  disabled?: boolean;
  className?: string;
  onPress?: () => void;
};
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  Platform: { OS: "ios" },
  ScrollView: (props: A11y) => <div>{props.children}</div>,
  View: (props: A11y) => (
    <div
      role={props.accessibilityRole}
      aria-label={props.accessibilityLabel}
      className={props.className}
    >
      {props.children}
    </div>
  ),
  Pressable: (props: A11y) => (
    <div
      role={props.accessibilityRole}
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      aria-pressed={props.accessibilityState?.selected}
      aria-disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (props.disabled !== true) props.onPress?.();
      }}
    >
      {props.children}
    </div>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null || mocks.titles[ref.threadId] === undefined
      ? null
      : { title: mocks.titles[ref.threadId], projectId: "p2" },
  useQuietThreadShells: () => mocks.shells,
  useThreadShells: () => mocks.shells,
  useProjects: () => [
    { id: "p1", environmentId: "env", workspaceRoot: "/work/app", title: "App Project" },
    { id: "p2", environmentId: "env", workspaceRoot: "/work/api", title: "Api Project" },
  ],
}));
vi.mock("../../state/heavyQueue", () => {
  const command = (id: string) => ({ permissionAtom: () => "p", id });
  return {
    heavyQueueEnvironment: {
      move: command("move"),
      startNow: command("startNow"),
      cancel: command("cancel"),
      setEnabled: command("setEnabled"),
      setPaused: command("setPaused"),
      setRule: command("setRule"),
      setPriority: command("setPriority"),
      stopCommand: command("stopCommand"),
      route: command("route"),
    },
    useHeavyQueueState: () => mocks.state,
    useHeavyCommandsState: () => mocks.heavy,
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    (mocks.commands[command.id] ??= vi.fn(async () => ({ _tag: "Success", value: undefined }))),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: "host" | "telemetry" | "devices" | null) => ({
    data: atom === null ? undefined : mocks[atom],
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { hostResources: () => "host", resourceTelemetry: () => "telemetry" },
}));
vi.mock("../../state/device", () => ({
  deviceEnvironment: {
    state: () => "devices",
    shutdown: { permissionAtom: () => "p", id: "shutdown" },
  },
}));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: { close: { id: "close" } } }));
vi.mock("../../state/use-terminal-session", () => ({
  useKnownTerminalSessions: () => ({ sessions: mocks.terminals }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    title: string;
    menus?: Array<{
      title: string;
      items: Array<{ id: string; title: string; selected?: boolean; onPress: () => void }>;
    }>;
    children: ReactNode;
  }) => (
    <main aria-label={props.title}>
      {props.menus?.map((menu) => (
        <nav key={menu.title} aria-label={menu.title}>
          {menu.items.map((item) => (
            <button key={item.id} aria-pressed={item.selected} onClick={item.onPress}>
              {item.title}
            </button>
          ))}
        </nav>
      ))}
      {props.children}
    </main>
  ),
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: (props: { title?: string; trailing?: ReactNode; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.trailing}
      {props.children}
    </section>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; detail?: string }) => (
    <p>{[props.label, props.description, props.detail].filter(Boolean).join("|")}</p>
  ),
}));
vi.mock("../../components/ui/RowMenuButton", () => ({
  RowMenuButton: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onAction: (id: string) => void;
  }) =>
    props.actions.map((action) => (
      <button
        key={action.id}
        disabled={action.attributes?.disabled}
        onClick={() => props.onAction(action.id)}
      >
        {action.title}
      </button>
    )),
}));
vi.mock("../settings/components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { HeavyWorkSection, ProjectHeavyWork } from "./HeavyWork";
import { ResourceManagerRouteScreen } from "./ResourceManagerRouteScreen";

const NOW = "2026-01-01T10:00:00.000Z";
const GIB = 1024 ** 3;
const entry = (id: string, extra: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `/usr/bin/cmd ${id}`,
  cwd: "/work/app/src",
  createdAt: NOW,
  startedAt: null,
  ...extra,
});
const heavy = (over: Partial<HeavyCommand>): HeavyCommand => ({
  source: "agent",
  pid: 12,
  startTimeMs: 34,
  threadId: "t1",
  label: "/usr/bin/node vp test run",
  name: "Tests",
  startedAt: NOW,
  stoppable: true,
  cpu: 2.5,
  memory: GIB,
  peakCpu: 3,
  peakMemory: 2 * GIB,
  ...over,
});

const setup = (entries: HeavyQueueEntry[], over: Partial<HeavyQueueState> = {}) => {
  mocks.state = {
    entries,
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 3,
    ...HEAVY_QUEUE_DEFAULTS,
    reasons: {},
    room: true,
    claudeHookInstalled: false,
    deviceIdleMinutes: 20,
    machine: null,
    hold: null,
    linux: null,
    macOnly: [],
    routes: {},
    ...over,
  };
};

const LINUX: HeavyRunnerLinux = {
  host: "remoto",
  online: true,
  slots: 2,
  running: 1,
  load1: 1.2,
  cpuCount: 6,
  availableMemoryBytes: 8 * GIB,
  totalMemoryBytes: 16 * GIB,
};

async function render(node: ReactNode) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(node));
  const button = (name: string, nth = 0) =>
    [...host.querySelectorAll("button")].filter((b) => b.textContent === name)[nth]!;
  return {
    host,
    button,
    rerender: (next: ReactNode) => act(async () => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

const mount = (commands: ReadonlyArray<HeavyCommand> = []) =>
  render(
    <HeavyWorkSection
      environmentId={"env" as EnvironmentId}
      state={mocks.state}
      commands={commands}
      cpuCount={8}
    />,
  );

/** Machine subgroups and rows in screen order: "# Linux" or "cmd c: Waiting, 1st · 1m". */
const outline = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="header"], [role="button"][aria-expanded]')].map((el) => {
    const label = el.getAttribute("aria-label") ?? "";
    if (el.getAttribute("role") === "header") return `# ${label}`;
    const [name, ...rest] = label.split(", ");
    return `${name}: ${rest.slice(0, 2).join(", ")}`;
  });
const row = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="button"][aria-expanded]')].find((el) =>
    el.getAttribute("aria-label")?.startsWith(`${name}, `),
  )!;
/** What a row shows once pressed: its line and every fact under it. */
const expand = async (host: HTMLElement, name: string) => {
  await act(async () => row(host, name).click());
  return row(host, name).parentElement!.parentElement!.textContent;
};
/** Durations read "1m" against a clock one minute after the entries were made. */
const oneMinuteLater = () => vi.useFakeTimers({ now: Date.parse(NOW) + 60_000 });
const alertButtons = (index: number) =>
  mocks.alert.mock.calls[index]![2] as Array<{ text: string; onPress?: () => unknown }>;

afterEach(() => {
  mocks.can = true;
  mocks.heavy = { commands: [], cpuCount: 8 };
  mocks.titles = {};
  mocks.shells = [];
  mocks.commands = {};
  mocks.host = null;
  mocks.telemetry = null;
  mocks.devices = null;
  mocks.terminals = [];
  mocks.focused = true;
  mocks.environments = [];
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("HeavyWorkSection", () => {
  it("keeps a row to its icon, name, project and short state, with every fact after a press", async () => {
    oneMinuteLater();
    mocks.titles = { t1: "Fix login" };
    setup(
      [
        entry("a", { startedAt: NOW, threadId: "t1", name: "Build iPhone", qos: "background" }),
        entry("b", { note: "Moved by the user" }),
        entry("c", { remote: { id: "r9" } as HeavyQueueEntry["remote"] }),
      ],
      {
        rules: [{ root: "/work/app", priority: "first" }],
        reasons: { b: "letting the last one ramp up" },
        estimates: { c: { cpu: 2, memoryBytes: GIB, durationMs: 60_000 } },
      },
    );
    const view = await mount();
    expect(outline(view.host)).toEqual([
      "Build iPhone: Running, 1m",
      "cmd b: Waiting, 1st · 1m",
      "cmd c: Waiting, 2nd · 1m",
    ]);
    // The reason shows under a waiter; the rest waits for a press.
    expect(row(view.host, "cmd b").textContent).toBe(
      "cmd b1st · 1mApp Projectletting the last one ramp up",
    );
    expect(row(view.host, "Build iPhone").textContent).toBe("Build iPhone1mApp Project");
    expect(await expand(view.host, "Build iPhone")).toContain(
      [
        "Command/usr/bin/cmd a",
        "Folder/work/app/src",
        "ThreadFix login",
        "Runs onThis Mac",
        "Running1m",
        "PriorityProject: Always first · Low priority",
        "UsageUnknown",
        "Processpid 1",
      ].join(""),
    );
    expect(await expand(view.host, "cmd b")).toContain(
      "Waiting1st in line · 1mPriorityProject: Always firstUsageUnknownWhy waitingletting the last one ramp upNoteMoved by the user",
    );
    expect(await expand(view.host, "cmd c")).toContain(
      "Waits forThis MacRun folder~/runs/r9Waiting2nd in line · 1m",
    );
    expect(row(view.host, "cmd c").getAttribute("aria-expanded")).toBe("true");
    await act(async () =>
      view.host.querySelector<HTMLElement>('[aria-label="Thread: Fix login"]')!.click(),
    );
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "t1" },
    });
    await act(async () => row(view.host, "cmd c").click());
    expect(row(view.host, "cmd c").getAttribute("aria-expanded")).toBe("false");
    await view.unmount();
  });

  it.each([
    {
      case: "one machine while the Runner is off, without machine names",
      entries: [entry("a", { startedAt: NOW }), entry("b"), entry("c")],
      over: {},
      outline: ["cmd a: Running, 1m", "cmd b: Waiting, 1st · 1m", "cmd c: Waiting, 2nd · 1m"],
    },
    {
      case: "each machine counting its own places",
      entries: [
        entry("a", { startedAt: NOW, runner: "linux", phase: "syncing" }),
        entry("b"),
        entry("c"),
        entry("d"),
      ],
      over: { linux: LINUX, routes: { b: "linux", d: "linux" } },
      outline: [
        "# This Mac",
        "cmd c: Waiting, 1st · 1m",
        "# Linux",
        "cmd a: Syncing, Syncing",
        "cmd b: Waiting, 1st · 1m",
        "cmd d: Waiting, 2nd · 1m",
      ],
    },
    {
      case: "a job still on Linux after the Runner went off",
      entries: [entry("a", { startedAt: NOW, runner: "linux" })],
      over: {},
      outline: ["# Linux", "cmd a: Running, 1m"],
    },
  ] satisfies ReadonlyArray<{
    case: string;
    entries: HeavyQueueEntry[];
    over: Partial<HeavyQueueState>;
    outline: string[];
  }>)("groups rows under This Mac and Linux: $case", async (rowCase) => {
    oneMinuteLater();
    setup(rowCase.entries, rowCase.over);
    const view = await mount();
    expect(outline(view.host)).toEqual(rowCase.outline);
    await view.unmount();
  });

  it("lists each job once, a direct command among the Mac's running, detached ones elsewhere", async () => {
    oneMinuteLater();
    setup([entry("q", { startedAt: NOW, pid: 30 }), entry("w")]);
    const view = await mount([
      heavy({ source: "queue", entryId: "q", pid: 30, name: "cmd q" }),
      heavy({ source: "agent", pid: 30, name: "cmd q seen early" }),
      heavy({ name: "Lint", pid: 40 }),
      heavy({ source: "detached", pid: 50, name: "playwright", threadId: null }),
    ]);
    expect(outline(view.host)).toEqual([
      "cmd q: Running, 1m",
      "Lint: Agent, 1m",
      "cmd w: Waiting, 1st · 1m",
    ]);
    await view.unmount();
  });

  it.each([
    {
      case: "the Runner's own count disagreeing with the entries",
      entries: [
        entry("a", { startedAt: NOW, runner: "linux" as const }),
        entry("b", { startedAt: NOW, runner: "linux" as const }),
        entry("c", { startedAt: NOW }),
      ],
      over: { linux: { ...LINUX, running: 0 } },
      counts: "Mac 1/3 · Linux 2/2",
    },
    {
      case: "the Mac alone",
      entries: [entry("c", { startedAt: NOW })],
      over: {},
      counts: "Mac 1/3",
    },
    {
      case: "no Mac slots while the queue is off",
      entries: [entry("c", { startedAt: NOW })],
      over: { enabled: false },
      counts: "Mac 1",
    },
  ])("counts running jobs per machine: $case", async ({ entries, over, counts }) => {
    setup(entries, over);
    const view = await mount();
    expect(view.host.querySelector("section")!.textContent).toContain(counts);
    await view.unmount();
  });

  it("hides while nothing runs and the queue is simply on, and pauses or turns it on", async () => {
    setup([]);
    const empty = await mount();
    expect(empty.host.innerHTML).toBe("");
    await empty.unmount();

    setup([], { paused: true });
    const paused = await mount();
    expect(paused.host.textContent).toContain("Nothing queued.");
    const pause = paused.host.querySelector<HTMLElement>(
      '[aria-label="Pause the heavy work queue"]',
    )!;
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    await act(async () => pause.click());
    expect(mocks.commands.setPaused).toHaveBeenCalledWith({
      environmentId: "env",
      input: { paused: false },
    });
    await paused.unmount();

    setup([], { enabled: false });
    const off = await mount();
    const turnOn = [...off.host.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (el) => el.textContent === "Turn on",
    )!;
    await act(async () => turnOn.click());
    expect(mocks.commands.setEnabled).toHaveBeenCalledWith({
      environmentId: "env",
      input: { enabled: true },
    });
    await off.unmount();
  });

  it("moves a waiter only within its own machine's line", async () => {
    setup([entry("a"), entry("b"), entry("c"), entry("d")], {
      linux: LINUX,
      routes: { b: "linux", d: "linux" },
    });
    const view = await mount();
    // Screen order: This Mac a, c; Linux b, d.
    expect(view.button("Move down", 1).disabled).toBe(true);
    expect(view.button("Move up", 2).disabled).toBe(true);
    await act(async () => view.button("Run next", 1).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "c", beforeId: "a" },
    });
    await act(async () => view.button("Move up", 3).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "d", beforeId: "b" },
    });
    await act(async () => view.button("Move down", 2).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "b", beforeId: null },
    });
    await act(async () => view.button("Move to end", 0).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "a", beforeId: null },
    });
    expect(view.button("Run next", 0).disabled).toBe(true);
    await view.unmount();
  });

  it("starts a waiter now on its own machine, only after the alert is confirmed", async () => {
    setup([entry("a", { startedAt: NOW }), entry("b"), entry("c")], {
      linux: LINUX,
      routes: { c: "linux" },
    });
    const view = await mount();
    await act(async () => view.button("Start now").click());
    expect(mocks.commands.startNow).not.toHaveBeenCalled();
    alertButtons(0)
      .find((b) => b.text === "Start now")
      ?.onPress?.();
    expect(mocks.commands.startNow).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "b" },
    });
    expect(mocks.alert.mock.calls[0]?.[1]).toBe(
      "cmd b starts now on this Mac, even if it is busy.",
    );
    await act(async () => view.button("Start now", 1).click());
    expect(mocks.alert.mock.calls[1]?.[1]).toBe("cmd c starts now on Linux, even if it is busy.");
    await view.unmount();
  });

  it("removes or stops only after the alert, and never a slot a server holds", async () => {
    setup([
      entry("a", { startedAt: NOW }),
      entry("b"),
      entry("s", { startedAt: NOW, server: true }),
    ]);
    const view = await mount();
    expect(view.button("Stop", 1)).toBeUndefined();
    await act(async () => view.button("Remove").click());
    expect(mocks.commands.cancel).not.toHaveBeenCalled();
    alertButtons(0)
      .find((b) => b.text === "Remove")
      ?.onPress?.();
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "b" },
    });
    await act(async () => view.button("Stop").click());
    alertButtons(1)
      .find((b) => b.text === "Stop")
      ?.onPress?.();
    expect(mocks.commands.cancel).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "a" },
    });
    await view.unmount();
  });

  it("opens the thread, and sets the project's priority through the alert", async () => {
    setup([entry("a", { threadId: "t9" })], { rules: [{ root: "/work/app", priority: "last" }] });
    const view = await mount();
    await act(async () => view.button("Open thread").click());
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "t9" },
    });
    await act(async () => view.button("Priority for this project").click());
    for (const text of ["Always first", "Last", "Normal"])
      alertButtons(0)
        .find((o) => o.text === text)
        ?.onPress?.();
    expect(mocks.commands.setRule!.mock.calls.map(([call]) => call.input)).toEqual([
      { root: "/work/app", priority: "first" },
      { root: "/work/app", priority: "last" },
      { root: "/work/app", priority: null },
    ]);
    await view.unmount();
  });

  it("offers each job only the priority changes that apply to it", async () => {
    setup([
      entry("a", { startedAt: NOW, priority: "low", qos: "normal" }),
      entry("d", { startedAt: NOW, qos: "background" }),
      entry("b"),
      entry("c", { priority: "high" }),
    ]);
    const view = await mount();
    expect(view.button("Lower priority", 1)).toBeUndefined();
    expect(view.button("Normal priority", 1)).toBeUndefined();
    expect(view.button("High priority now", 1)).toBeUndefined();
    await act(async () => view.button("High priority now").click());
    await act(async () => view.button("Lower priority").click());
    await act(async () => view.button("Normal priority").click());
    expect(mocks.commands.setPriority!.mock.calls.map(([call]) => call.input)).toEqual([
      { id: "b", priority: "high" },
      { id: "a", priority: "low" },
      { id: "d", priority: "high" },
    ]);
    await view.unmount();
  });

  it("moves a row between runners, confirming a stop or an unconfirmed rerun first", async () => {
    setup([entry("a", { startedAt: NOW }), entry("b", { unconfirmed: true }), entry("c")], {
      linux: LINUX,
      routes: { b: "linux" },
      macOnly: ["c"],
    });
    const view = await mount();
    // Running on the Mac: only Linux; the Mac-only waiter c: only pinning it to the Mac.
    expect(view.button("Run on this Mac", 2)).toBeUndefined();
    expect(view.button("Run on Linux", 2)).toBeUndefined();
    await act(async () => view.button("Run on Linux", 0).click());
    expect(mocks.commands.route).not.toHaveBeenCalled();
    expect(mocks.alert.mock.calls[0]![1]).toContain("Stop this job and run it again on Linux?");
    alertButtons(0).find((b) => b.text === "Run on Linux")!.onPress!();
    expect(mocks.commands.route).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "a", runner: "linux", force: false },
    });
    // Screen order: This Mac a, c; Linux b.
    await act(async () => view.button("Run on this Mac", 1).click());
    expect(mocks.alert.mock.calls[1]![1]).toContain("may run it twice");
    alertButtons(1).find((b) => b.text === "Run on this Mac")!.onPress!();
    expect(mocks.commands.route).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "b", runner: "mac", force: true },
    });
    await act(async () => view.button("Run on this Mac", 0).click());
    expect(mocks.alert).toHaveBeenCalledTimes(2);
    expect(mocks.commands.route).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "c", runner: "mac", force: false },
    });
    await view.unmount();
  });

  it("asks where a job runs with a live countdown, and answers or cancels it", async () => {
    vi.useFakeTimers({ now: Date.parse(NOW) });
    const ask = { reason: "unavailable" as const, deadlineAt: "2026-01-01T10:01:05.000Z" };
    setup([entry("a", { ask })], { linux: { ...LINUX, online: false } });
    const view = await mount();
    const askRow = () =>
      [...view.host.querySelectorAll("p")].find((p) =>
        p.textContent?.startsWith("Linux is unavailable"),
      )!.textContent;
    expect(askRow()).toMatch(/\|1:05$/);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(askRow()).toMatch(/\|1:04$/);
    expect(view.button("Remove")).toBeUndefined();
    expect(view.button("Run on Linux")).toBeUndefined();
    await act(async () => view.button("Wait for Linux").click());
    await act(async () => view.button("Run on this Mac").click());
    expect(mocks.commands.route!.mock.calls.map(([call]) => call.input)).toEqual([
      { id: "a", runner: "linux", force: false },
      { id: "a", runner: "mac", force: false },
    ]);
    await act(async () => view.button("Cancel").click());
    alertButtons(0).find((b) => b.text === "Remove")!.onPress!();
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "a" },
    });
    await view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms before running an unconfirmed ask on this Mac, and forces it", async () => {
    const ask = { reason: "dropped" as const, deadlineAt: NOW };
    setup([entry("a", { ask, unconfirmed: true })], { linux: LINUX });
    const view = await mount();
    await act(async () => view.button("Run on this Mac").click());
    expect(mocks.commands.route).not.toHaveBeenCalled();
    expect(mocks.alert.mock.calls[0]![1]).toContain("may run it twice");
    alertButtons(0).find((b) => b.text === "Run on this Mac")!.onPress!();
    expect(mocks.commands.route).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "a", runner: "mac", force: true },
    });
    await view.unmount();
  });

  it("disables the actions without permission", async () => {
    mocks.can = false;
    setup([entry("b"), entry("c"), entry("d", { ask: { reason: "dropped", deadlineAt: NOW } })], {
      linux: LINUX,
      paused: true,
    });
    const view = await mount([heavy({})]);
    const actions = [...view.host.querySelectorAll("button")].filter(
      (button) => button.textContent !== "Open thread",
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((button) => button.disabled)).toBe(true);
    expect(
      view.host
        .querySelector('[aria-label="Pause the heavy work queue"]')!
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await view.unmount();
  });

  it("describes a direct command with every fact, and stops it after the alert", async () => {
    oneMinuteLater();
    mocks.titles = { t1: "Fix login" };
    setup([]);
    const view = await mount([
      heavy({ cwd: "/work/api/pkg" }),
      heavy({ source: "terminal", pid: 50, entryId: "q1", threadId: null, name: "Build" }),
    ]);
    expect(row(view.host, "Tests").textContent).toBe("Tests1mApi Project");
    expect(await expand(view.host, "Tests")).toContain(
      [
        "Command/usr/bin/node vp test run",
        "Folder/work/api/pkg",
        "ThreadFix login",
        "Started byAgent",
        "Running1m",
        "UsageUsing 2.5 cores (31%) · 1.0 GB · peak 3.0 cores · 2.0 GB",
        "Processpid 12",
      ].join(""),
    );
    const stops = [view.button("Stop", 0), view.button("Stop", 1)];
    await act(async () => stops[0]!.click());
    expect(mocks.commands.stopCommand).not.toHaveBeenCalled();
    await act(async () => {
      await alertButtons(0).find((b) => b.text === "Stop")!.onPress!();
    });
    expect(mocks.commands.stopCommand).toHaveBeenCalledWith({
      environmentId: "env",
      input: { pid: 12, startTimeMs: 34 },
    });
    await act(async () => stops[1]!.click());
    await act(async () => {
      await alertButtons(1).find((b) => b.text === "Stop")!.onPress!();
    });
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "q1" },
    });
    mocks.commands.stopCommand!.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("That process is not a command an agent or terminal runs.")),
    });
    await act(async () => stops[0]!.click());
    await act(async () => {
      await alertButtons(2).find((b) => b.text === "Stop")!.onPress!();
    });
    expect(mocks.alert).toHaveBeenLastCalledWith(
      "Could not stop it",
      "That process is not a command an agent or terminal runs.",
    );
    await view.unmount();
  });
});

describe("ProjectHeavyWork", () => {
  it("shows only a project's work, worktree ones included, with places counted on their machine", async () => {
    oneMinuteLater();
    mocks.shells = [
      { environmentId: "env", id: "t9", projectId: "p1" },
      { environmentId: "env", id: "t7", projectId: "p1" },
    ];
    setup([
      entry("a", { startedAt: NOW }),
      entry("b", { cwd: "/work/api" }),
      entry("c", { cwd: "/worktrees/app-1", threadId: "t9" }),
      entry("d", { cwd: "/elsewhere" }),
    ]);
    mocks.heavy = {
      commands: [
        heavy({ name: "Worktree", pid: 70, threadId: "t7", cwd: "/worktrees/app-2" }),
        heavy({ name: "Elsewhere", pid: 71, threadId: null, cwd: "/work/api" }),
      ],
      cpuCount: 8,
    };
    const view = await render(
      <ProjectHeavyWork environmentId={"env" as EnvironmentId} projectId="p1" />,
    );
    expect(outline(view.host)).toEqual([
      "cmd a: Running, 1m",
      "Worktree: Agent, 1m",
      "cmd c: Waiting, 2nd · 1m",
    ]);
    expect(view.host.textContent).not.toContain("App Project");
    expect(view.host.querySelector("section")?.getAttribute("aria-label")).toBe("Heavy work");
    await view.unmount();

    const empty = await render(
      <ProjectHeavyWork environmentId={"env" as EnvironmentId} projectId="p3" />,
    );
    expect(empty.host.textContent).toContain("No heavy work in this project");
    await empty.unmount();
  });
});

describe("ResourceManagerRouteScreen", () => {
  const MACHINE = {
    busyCores: 6,
    cpuCount: 8,
    availableMemoryBytes: 2 * GIB,
    totalMemoryBytes: 16 * GIB,
    pressureLevel: null,
    swapInBytesPerSecond: null,
  };
  const screen = () => render(<ResourceManagerRouteScreen />);
  const sections = (host: HTMLElement) =>
    [...host.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"));

  it("orders the machines, Heavy work, then Outside T3, where a detached command shows its reason and no Stop", async () => {
    oneMinuteLater();
    mocks.environments = [
      { environmentId: "env", label: "Studio", connection: { phase: "connected" } },
      { environmentId: "off", label: "Laptop", connection: { phase: "disconnected" } },
    ];
    setup([entry("a", { startedAt: NOW })], { machine: MACHINE });
    mocks.heavy = {
      commands: [
        heavy({
          source: "detached",
          pid: 90,
          threadId: null,
          stoppable: true,
          name: "playwright",
          reason: "Started by mac-all.sh, outside any agent",
        }),
      ],
      cpuCount: 8,
    };
    const view = await screen();
    expect(sections(view.host)).toEqual([null, "Heavy work", "Outside T3"]);
    const outside = view.host.querySelectorAll("section")[2]!;
    expect(outside.querySelector("button")).toBeNull();
    expect(row(outside as HTMLElement, "playwright").textContent).toBe("playwright1m");
    expect(await expand(outside as HTMLElement, "playwright")).toContain(
      "Started byOutside agentsRunning1mUsageUsing 2.5 cores (31%) · 1.0 GB · peak 3.0 cores · 2.0 GBWhyStarted by mac-all.sh, outside any agentProcesspid 90",
    );
    await view.unmount();
  });

  it("names each environment when several are connected, says when nothing runs, and stops sampling when hidden", async () => {
    mocks.environments = [
      { environmentId: "env", label: "Studio", connection: { phase: "connected" } },
      { environmentId: "env2", label: "Mini", connection: { phase: "connected" } },
    ];
    setup([]);
    const view = await screen();
    expect(sections(view.host)).toEqual(["Studio", null, "Mini", null]);
    expect(view.host.textContent).toContain("Nothing running right now");
    await view.unmount();

    mocks.focused = false;
    const hidden = await screen();
    expect(hidden.host.querySelector("section")).toBeNull();
    await hidden.unmount();
  });

  it("lists projects, devices, T3 Code and outside devices from telemetry, sorted by the Sort menu", async () => {
    mocks.environments = [
      { environmentId: "env", label: "Studio", connection: { phase: "connected" } },
    ];
    setup([]);
    const proc = (
      pid: number,
      childPids: number[],
      memory: number,
      cpu: number,
      name: string,
      command = name,
      category = "server-child",
    ) => ({
      identity: { pid, startTimeMs: 0 },
      childPids,
      residentBytes: memory,
      cpuPercent: cpu,
      category,
      name,
      command,
    });
    const group = { currentCpuPercent: 80, currentRssBytes: 3 * GIB, processCount: 6 };
    mocks.telemetry = {
      cpuCount: 8,
      processes: [
        proc(1, [], GIB, 8, "T3 Code", "T3 Code", "electron-main"),
        proc(50, [51], GIB / 2, 8, "claude"),
        proc(52, [], 1024 ** 2, 0, "codex"),
        proc(51, [], GIB, 600, "node", "node build.js"),
        proc(60, [], 100 * 1024 ** 2, 8, "zsh"),
        proc(70, [71], 1024 ** 2, 0, "hub"),
        proc(71, [], GIB, 80, "qemu-system-aarch64", "qemu-system-aarch64 -avd Pixel_9"),
        proc(
          80,
          [],
          GIB,
          80,
          "qemu-system-x86",
          "qemu-system-x86 -avd Tablet_X",
          "external-device",
        ),
      ],
      owners: [
        { kind: "agent", pid: 50, threadId: "t1" },
        { kind: "agent", pid: 52, threadId: "t2" },
        { kind: "device-hub", pid: 70 },
      ],
      groups: { backend: group, electron: group, monitor: group, allT3: group },
    };
    mocks.devices = {
      hosts: [{ kind: "local", id: "h" }],
      devices: [
        {
          booted: true,
          physical: false,
          hostId: "h",
          platform: "android",
          id: "emu-1",
          name: "Pixel_9",
        },
      ],
    };
    mocks.terminals = [
      {
        target: { environmentId: "env", threadId: "t2", terminalId: "term-1" },
        state: {
          status: "running",
          hasRunningSubprocess: true,
          summary: { label: "dev server", pid: 60, cwd: "/work/app" },
        },
      },
    ];
    mocks.shells = [
      { environmentId: "env", id: "t1", projectId: "p1", title: "Fix build", runtime: null },
      {
        environmentId: "env",
        id: "t2",
        projectId: "p1",
        title: "Docs",
        runtime: { status: "running" },
      },
    ];
    const view = await screen();
    expect(sections(view.host)).toEqual([null, "App Project", "Devices", "T3 Code", "Outside T3"]);
    expect(view.host.textContent).not.toContain("Nothing running right now");
    expect(view.host.textContent).toContain("T3 total · 10% · ");
    const [, project, devices, app, outside] = [...view.host.querySelectorAll("section")];
    expect(outline(project!)).toEqual([
      "Fix build: Agent, 76% · 1.50 GB",
      "dev server: Terminal, 1.0% · 100 MB",
      "Docs: Agent, 0% · 1 MB",
    ]);
    expect(row(project!, "Docs").textContent).not.toContain("idle");
    expect(row(project!, "Fix build").textContent).toBe("Fix build76% · 1.50 GBidle");
    expect(row(project!, "dev server").textContent).toContain("running");
    expect(await expand(project!, "Fix build")).toContain(
      "ThreadFix buildNoteIdle agent session, kept open for follow-ups",
    );
    expect(row(project!, "Fix build").parentElement!.parentElement!.textContent).toContain(
      "node build.js · pid 51",
    );
    expect(
      [...project!.querySelectorAll(".text-warning-foreground")].map((el) => el.textContent),
    ).toEqual(["build.js", "75% · 1.00 GB"]);

    const names = () => outline(project!).map((line) => line.split(":")[0]);
    const telemetry = mocks.telemetry as { processes: Array<ReturnType<typeof proc>> };
    mocks.telemetry = {
      ...telemetry,
      processes: telemetry.processes.map((p) =>
        p.identity.pid === 52 ? { ...p, residentBytes: 4 * GIB } : p,
      ),
    };
    await view.rerender(<ResourceManagerRouteScreen />);
    expect(row(project!, "Docs").textContent).toContain("4.00 GB");
    expect(names()).toEqual(["Fix build", "dev server", "Docs"]);

    await act(async () => view.button("Name").click());
    expect(names()).toEqual(["dev server", "Docs", "Fix build"]);
    expect(view.button("Name").getAttribute("aria-pressed")).toBe("true");
    expect(view.button("Memory").getAttribute("aria-pressed")).toBe("false");
    await act(async () => view.button("Memory").click());
    expect(names()).toEqual(["Docs", "Fix build", "dev server"]);

    await act(async () => view.button("End terminal").click());
    expect(mocks.alert.mock.calls[0]![0]).toBe(
      'Close terminal "dev server" and stop its processes?',
    );
    mocks.commands.close!.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Terminal is gone")),
    });
    await act(async () => alertButtons(0)[1]!.onPress?.());
    expect(mocks.commands.close).toHaveBeenCalledWith({
      environmentId: "env",
      input: { threadId: "t2", terminalId: "term-1" },
    });
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not close terminal", "Terminal is gone");

    expect(row(devices!, "Pixel 9")).toBeDefined();
    await act(async () => view.button("Shut down").click());
    await act(async () => alertButtons(2)[1]!.onPress?.());
    expect(mocks.commands.shutdown).toHaveBeenCalledWith({
      environmentId: "env",
      input: { hostId: "h", deviceId: "emu-1", platform: "android" },
    });

    expect(outline(app!)).toEqual(["T3 Code: 1, 1.0% · 1.00 GB"]);
    await act(async () => row(app!, "T3 Code").click());
    expect(outline(app!)).toEqual([
      "T3 Code: 1, 1.0% · 1.00 GB",
      "Desktop main (1): Desktop main, 1.0% · 1.00 GB",
    ]);
    expect(await expand(outside!, "Tablet X")).toContain(
      "NoteRuns outside T3, not counted in the T3 total",
    );
    expect(outside!.querySelector("button")).toBeNull();
    await view.unmount();
  });

  it.each([
    {
      case: "the Mac's CPU hold colours the CPU gauge and is worded on press",
      over: { machine: MACHINE, hold: "cpu" as const, entries: [entry("w")] },
      label: "This Mac, CPU 75%, 2.0 GB free, 0 of 3 running, warning",
      warn: "75%",
      hints: ["CPU 75% · 6.0 of 8 cores busy · "],
    },
    {
      case: "no reading yet, and the queue off",
      over: { enabled: false },
      label: "This Mac, CPU --, -- free, Off",
      warn: null,
      hints: [
        "No CPU reading yet",
        "No memory reading yet",
        "Queue off: heavy jobs start right away",
      ],
    },
  ])("shows This Mac's gauges: $case", async ({ over, label, warn, hints }) => {
    mocks.environments = [
      { environmentId: "env", label: "Studio", connection: { phase: "connected" } },
    ];
    setup(over.entries ?? [], over);
    const view = await screen();
    const mac = view.host.querySelector<HTMLElement>('[aria-label^="This Mac"]')!;
    expect(mac.getAttribute("aria-label")).toBe(label);
    expect(
      [...mac.querySelectorAll(".text-warning-foreground")].map((el) => el.textContent),
    ).toEqual(warn === null ? [] : [warn]);
    await act(async () => mac.click());
    for (const hint of hints) expect(mac.textContent).toContain(hint);
    expect(view.host.querySelector('[aria-label^="Linux"]')).toBeNull();
    await view.unmount();
  });

  it("shows Linux only while the Runner reports it, its load as a share of cores, and its trouble", async () => {
    mocks.environments = [
      { environmentId: "env", label: "Studio", connection: { phase: "connected" } },
    ];
    setup([entry("a", { startedAt: NOW, runner: "linux" })], { linux: { ...LINUX, running: 0 } });
    const view = await screen();
    expect(view.host.querySelector('[aria-label^="Linux"]')!.getAttribute("aria-label")).toBe(
      "Linux, online, CPU 20%, 8.0 GB free, 1 of 2 running",
    );
    await view.unmount();

    setup([], { linux: { ...LINUX, online: false, error: "ssh timed out" } });
    const offline = await screen();
    const linux = offline.host.querySelector<HTMLElement>('[aria-label^="Linux"]')!;
    expect(linux.getAttribute("aria-label")).toBe("Linux, offline, 0 of 2 running");
    expect(linux.textContent).toContain("Offline");
    await act(async () => linux.click());
    expect(linux.textContent).toContain("Linux offline: ssh timed out");
    await offline.unmount();
  });
});
