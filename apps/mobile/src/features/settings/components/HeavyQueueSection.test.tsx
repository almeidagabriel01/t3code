import type {
  EnvironmentId,
  HeavyCommand,
  HeavyCommandsState,
  HeavyQueueEntry,
  HeavyQueueState,
  HeavyRunnerLinux,
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
    shells: [] as Array<{ environmentId: string; id: string; projectId: string }>,
  },
}));

vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("../../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null || mocks.titles[ref.threadId] === undefined
      ? null
      : { title: mocks.titles[ref.threadId], projectId: "p2" },
  useQuietThreadShells: () => mocks.shells,
  useProjects: () => [
    { id: "p1", environmentId: "env", workspaceRoot: "/work/app", title: "App Project" },
    { id: "p2", environmentId: "env", workspaceRoot: "/work/api", title: "Api Project" },
  ],
}));
vi.mock("../../../state/heavyQueue", () => {
  const command = (id: string) => ({ permissionAtom: () => "p", id });
  return {
    heavyQueueEnvironment: {
      move: command("move"),
      startNow: command("startNow"),
      cancel: command("cancel"),
      setEnabled: command("setEnabled"),
      setPaused: command("setPaused"),
      setRule: command("setRule"),
      setMaxRunning: command("setMaxRunning"),
      setPriority: command("setPriority"),
      setClaudeHook: command("setClaudeHook"),
      setDeviceIdleMinutes: command("setDeviceIdleMinutes"),
      stopCommand: command("stopCommand"),
      route: command("route"),
    },
    useHeavyQueueState: () => mocks.state,
    useHeavyCommandsState: () => mocks.heavy,
  };
});
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    (mocks.commands[command.id] ??= vi.fn(async () => ({ _tag: "Success", value: undefined }))),
}));
vi.mock("../../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: {
    label: string;
    description?: string;
    detail?: string;
    accessory?: ReactNode;
  }) => (
    <>
      <p>{[props.label, props.description, props.detail].filter(Boolean).join("|")}</p>
      {props.accessory}
    </>
  ),
}));
vi.mock("../../../components/ui/RowMenuButton", () => ({
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
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-checked={props.selected} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.label}
      checked={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));

import { HeavyCommandsSection, HeavyQueueSection, type RunnerMode } from "./HeavyQueueSection";

const NOW = "2026-01-01T10:00:00.000Z";
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

const setup = (entries: HeavyQueueEntry[], over: Partial<HeavyQueueState> = {}) => {
  mocks.state = {
    entries,
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 3,
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

const RUNNER_OFF: RunnerMode = { enabled: false, where: "mac", overflow: 3 };
const LINUX: HeavyRunnerLinux = {
  host: "remoto",
  online: true,
  slots: 2,
  running: 1,
  load1: 1.2,
  cpuCount: 6,
  availableMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3,
};

async function mount(projectId?: string, runner = RUNNER_OFF) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HeavyQueueSection
        environmentId={"env" as EnvironmentId}
        runner={runner}
        {...(projectId === undefined ? {} : { projectId })}
      />,
    );
  });
  const button = (name: string, nth = 0) =>
    [...host.querySelectorAll("button")].filter((b) => b.textContent === name)[nth]!;
  const toggle = (name: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  return { host, button, toggle, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.can = true;
  mocks.heavy = { commands: [], cpuCount: 8 };
  mocks.titles = {};
  mocks.shells = [];
  mocks.commands = {};
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("HeavyQueueSection", () => {
  it("says so when nothing is queued, with the slot summary", async () => {
    setup([]);
    const view = await mount();
    expect(view.host.textContent).toContain("0 of 3 running");
    expect(view.host.textContent).toContain("Nothing queued.");
    await view.unmount();
  });

  it("describes each entry with project, thread, rule, reason and note", async () => {
    mocks.titles = { t1: "Fix login" };
    setup(
      [
        entry("a", { startedAt: NOW, threadId: "t1", name: "Build iPhone" }),
        entry("b", { note: "Moved by the user" }),
        entry("c"),
      ],
      {
        rules: [{ root: "/work/app", priority: "first" }],
        reasons: { b: "letting the last one ramp up" },
      },
    );
    const view = await mount();
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent);
    expect(rows.find((row) => row?.startsWith("Build iPhone"))).toMatch(
      /^Build iPhone\|cmd a · App Project · Fix login · Always first · Running /,
    );
    expect(rows.find((row) => row?.startsWith("cmd b"))).toMatch(
      /Waiting .* · letting the last one ramp up · Moved by the user\|#1$/,
    );
    expect(rows.find((row) => row?.startsWith("cmd c"))).toMatch(/\|#2$/);
    await view.unmount();
  });

  it("moves waiters and offers only the moves that change something", async () => {
    setup([entry("a", { startedAt: NOW }), entry("b"), entry("c"), entry("d")]);
    const view = await mount();
    expect(view.button("Run next", 0).disabled).toBe(true);
    expect(view.button("Move up", 0).disabled).toBe(true);
    await act(async () => view.button("Run next", 1).click());
    expect(mocks.commands.move).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "c", beforeId: "b" },
    });
    await act(async () => view.button("Move down", 0).click());
    expect(mocks.commands.move).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "b", beforeId: "d" },
    });
    await act(async () => view.button("Move to end", 0).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "b", beforeId: null },
    });
    await act(async () => view.button("Move up", 2).click());
    expect(mocks.commands.move).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "d", beforeId: "c" },
    });
    await view.unmount();
  });

  it("starts a waiter now only after the alert is confirmed", async () => {
    setup([entry("a", { startedAt: NOW }), entry("b")]);
    const view = await mount();
    await act(async () => view.button("Start now").click());
    expect(mocks.commands.startNow).not.toHaveBeenCalled();
    const buttons = mocks.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.text === "Start now")?.onPress?.();
    expect(mocks.commands.startNow).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "b" },
    });
    await view.unmount();
  });

  it("removes or stops only after the alert is confirmed", async () => {
    setup([entry("a", { startedAt: NOW }), entry("b")]);
    const view = await mount();
    await act(async () => view.button("Remove").click());
    expect(mocks.commands.cancel).not.toHaveBeenCalled();
    const buttons = mocks.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.text === "Remove")?.onPress?.();
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "b" },
    });
    await act(async () => view.button("Stop").click());
    const stop = mocks.alert.mock.calls[1]?.[2] as Array<{ text: string; onPress?: () => void }>;
    stop.find((b) => b.text === "Stop")?.onPress?.();
    expect(mocks.commands.cancel).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "a" },
    });
    await view.unmount();
  });

  it("cannot stop a slot a server holds", async () => {
    setup([entry("a", { startedAt: NOW, server: true })]);
    const view = await mount();
    expect(view.host.textContent).not.toContain("Stop");
    await view.unmount();
  });

  it("opens the thread that queued it", async () => {
    setup([entry("a", { threadId: "t9" })]);
    const view = await mount();
    await act(async () => view.button("Open thread").click());
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "t9" },
    });
    await view.unmount();
  });

  it("sets the project's priority through the alert, and removes a rule", async () => {
    setup([entry("a")], {
      rules: [
        { root: "/work/app", priority: "last" },
        { root: "/gone", priority: "first" },
      ],
    });
    const view = await mount();
    await act(async () => view.button("Priority for this project").click());
    const options = mocks.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress: () => void }>;
    for (const text of ["Always first", "Last", "Normal"])
      options.find((o) => o.text === text)?.onPress();
    expect(mocks.commands.setRule!.mock.calls.map(([call]) => call.input)).toEqual([
      { root: "/work/app", priority: "first" },
      { root: "/work/app", priority: "last" },
      { root: "/work/app", priority: null },
    ]);
    await act(async () => view.button("App Project: Last").click());
    await act(async () => view.button("/gone: Always first").click());
    expect(mocks.commands.setRule).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { root: "/gone", priority: null },
    });
    await view.unmount();
  });

  it("pauses the queue and changes the number of slots within limits", async () => {
    setup([], { maxRunning: 1 });
    const view = await mount();
    expect(view.button("Allow one fewer").disabled).toBe(true);
    await act(async () => view.toggle("Pause queue").click());
    expect(mocks.commands.setPaused).toHaveBeenCalledWith({
      environmentId: "env",
      input: { paused: true },
    });
    await act(async () => view.button("Allow one more").click());
    expect(mocks.commands.setMaxRunning).toHaveBeenCalledWith({
      environmentId: "env",
      input: { maxRunning: 2 },
    });
    await view.unmount();
    setup([], { maxRunning: 8 });
    const full = await mount();
    expect(full.button("Allow one more").disabled).toBe(true);
    await act(async () => full.button("Allow one fewer").click());
    expect(mocks.commands.setMaxRunning).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { maxRunning: 7 },
    });
    await full.unmount();
  });

  it("switches the queue off and on, and locks pause, slots and rules while it is off", async () => {
    setup([]);
    const on = await mount();
    expect(on.toggle("Heavy work queue").checked).toBe(true);
    expect(on.toggle("Pause queue").disabled).toBe(false);
    await act(async () => on.toggle("Heavy work queue").click());
    expect(mocks.commands.setEnabled).toHaveBeenCalledWith({
      environmentId: "env",
      input: { enabled: false },
    });
    await on.unmount();

    setup([entry("a", { startedAt: NOW })], {
      enabled: false,
      paused: true,
      maxRunning: 4,
      rules: [{ root: "/work/app", priority: "last" }],
    });
    const off = await mount();
    expect(off.host.textContent).toContain("Queue off: heavy jobs start right away");
    expect(off.host.textContent).not.toContain("1 of 4 running");
    expect(off.host.textContent).toContain("Run up to 4 at once");
    expect(off.toggle("Pause queue")).toMatchObject({ disabled: true, checked: true });
    for (const name of ["Allow one more", "Allow one fewer", "App Project: Last"]) {
      expect(off.button(name).disabled).toBe(true);
    }
    expect(off.button("Stop").disabled).toBe(false);
    expect(off.toggle("Heavy work queue")).toMatchObject({ disabled: false, checked: false });
    await act(async () => off.toggle("Heavy work queue").click());
    expect(mocks.commands.setEnabled).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { enabled: true },
    });
    await off.unmount();
  });

  it("installs the Claude hook and picks the idle minutes", async () => {
    setup([]);
    const view = await mount();
    expect(view.button("20 min").getAttribute("aria-checked")).toBe("true");
    await act(async () => view.toggle("Claude Code hook").click());
    expect(mocks.commands.setClaudeHook).toHaveBeenCalledWith({
      environmentId: "env",
      input: { installed: true },
    });
    await act(async () => view.button("Off").click());
    await act(async () => view.button("60 min").click());
    expect(mocks.commands.setDeviceIdleMinutes!.mock.calls.map(([call]) => call.input)).toEqual([
      { minutes: 0 },
      { minutes: 60 },
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

  it("shows only a project's jobs, worktree ones included, with machine-wide places", async () => {
    mocks.shells = [{ environmentId: "env", id: "t9", projectId: "p1" }];
    setup([
      entry("a", { startedAt: NOW }),
      entry("b", { cwd: "/work/api" }),
      entry("c", { cwd: "/worktrees/app-1", threadId: "t9" }),
      entry("d", { cwd: "/elsewhere" }),
    ]);
    const view = await mount("p1");
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent ?? "");
    expect(rows[0]).toMatch(/^Whole queue: 1 of 3 running/);
    expect(rows.filter((row) => row.startsWith("cmd "))).toEqual([
      expect.stringMatching(/^cmd a\|/),
      expect.stringMatching(/^cmd c\|.*\|#2$/),
    ]);
    expect(rows.some((row) => row.includes("App Project"))).toBe(false);
    expect(view.host.querySelector("section")?.getAttribute("aria-label")).toBe("Queue");
    expect(view.toggle("Pause queue")).toBeNull();
    expect(view.button("Allow one more")).toBeUndefined();
    await act(async () => view.button("Stop").click());
    expect(mocks.alert).toHaveBeenCalledWith(
      "Stop the running command?",
      "cmd a",
      expect.any(Array),
    );
    await view.unmount();

    const empty = await mount("p2-missing");
    expect(empty.host.textContent).toContain("Nothing queued for this project.");
    await empty.unmount();
  });

  it("says what the queue and the Runner do together", async () => {
    setup([]);
    const off = await mount();
    expect(off.host.textContent).toContain("Heavy jobs wait their turn on this Mac.");
    await off.unmount();
    const auto = await mount(undefined, { enabled: true, where: "automatic", overflow: 2 });
    expect(auto.host.textContent).toContain(
      "Heavy jobs queue on this Mac; past 2 jobs, listed commands go to Linux.",
    );
    await auto.unmount();
  });

  it("badges where each row runs and notes an unconfirmed Linux stop", async () => {
    setup(
      [
        entry("a", { startedAt: NOW, runner: "linux", phase: "syncing" }),
        entry("b", { unconfirmed: true }),
        entry("c"),
      ],
      { linux: LINUX, routes: { b: "linux" } },
    );
    const view = await mount();
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.includes("cmd a"))).toMatch(/^cmd a\|Linux · Syncing · /);
    expect(rows.find((row) => row.includes("cmd b"))).toMatch(
      /^cmd b\|Linux · cmd b · .* · Linux has not confirmed the earlier run stopped\.\|#1$/,
    );
    expect(rows.find((row) => row.includes("cmd c"))).toMatch(/^cmd c\|This Mac · /);
    await view.unmount();
    setup([entry("c")]);
    const off = await mount();
    expect(off.host.textContent).not.toContain("This Mac ·");
    expect(off.host.textContent).not.toContain("Run on");
    await off.unmount();
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
    const stop = mocks.alert.mock.calls[0]!;
    expect(stop[1]).toContain("Stop this job and run it again on Linux?");
    (stop[2] as Array<{ text: string; onPress?: () => void }>).find(
      (b) => b.text === "Run on Linux",
    )!.onPress!();
    expect(mocks.commands.route).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "a", runner: "linux", force: false },
    });
    await act(async () => view.button("Run on this Mac", 0).click());
    expect(mocks.alert.mock.calls[1]![1]).toContain("may run it twice");
    (mocks.alert.mock.calls[1]![2] as Array<{ text: string; onPress?: () => void }>).find(
      (b) => b.text === "Run on this Mac",
    )!.onPress!();
    expect(mocks.commands.route).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { id: "b", runner: "mac", force: true },
    });
    await act(async () => view.button("Run on this Mac", 1).click());
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
      [...view.host.querySelectorAll("p")].find((row) =>
        row.textContent?.startsWith("Linux is unavailable"),
      )!.textContent;
    expect(askRow()).toMatch(/\|1:05$/);
    expect(
      [...view.host.querySelectorAll("p")].some((row) => row.textContent === "Linux offline"),
    ).toBe(true);
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
    (mocks.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => void }>).find(
      (b) => b.text === "Remove",
    )!.onPress!();
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
    (mocks.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => void }>).find(
      (b) => b.text === "Run on this Mac",
    )!.onPress!();
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
    });
    const view = await mount();
    expect(
      [...view.host.querySelectorAll("button, input")].every(
        (el) => (el as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    await view.unmount();
  });
});

const GIB = 1024 ** 3;
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

async function mountCommands(commands: ReadonlyArray<HeavyCommand>, projectId?: string) {
  mocks.heavy = { commands, cpuCount: 8 };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HeavyCommandsSection
        environmentId={"env" as EnvironmentId}
        {...(projectId === undefined ? {} : { projectId })}
      />,
    );
  });
  const buttons = (name: string) =>
    [...host.querySelectorAll("button")].filter((b) => b.textContent === name);
  return { host, buttons, unmount: () => act(() => root.unmount()) };
}

const confirmAlert = (index: number) => {
  const buttons = mocks.alert.mock.calls[index]![2] as Array<{
    text: string;
    onPress?: () => unknown;
  }>;
  return act(async () => {
    await buttons.find((b) => b.text === "Stop")!.onPress!();
  });
};

describe("HeavyCommandsSection", () => {
  it("renders nothing while no heavy command runs", async () => {
    const view = await mountCommands([]);
    expect(view.host.innerHTML).toBe("");
    await view.unmount();
  });

  it("describes each command with usage, project, thread, origin and run time", async () => {
    mocks.titles = { t1: "Fix login" };
    const view = await mountCommands([
      heavy({
        source: "queue",
        entryId: "q1",
        threadId: null,
        cwd: "/work/app/src",
        name: "Build",
      }),
      heavy({}),
    ]);
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent);
    expect(rows[0]).toMatch(
      /^Build\|node vp test run · Using 2.5 cores \(31%\) · 1.0 GB · peak 3.0 cores · 2.0 GB · App Project · Queued · Running /,
    );
    expect(rows[1]).toMatch(
      /^Tests\|node vp test run · .* · Api Project · Fix login · Agent · Running /,
    );
    await act(async () => view.buttons("Open thread")[0]!.click());
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "t1" },
    });
    await view.unmount();
  });

  it("stops after the alert: a direct command by its process, a queued one through the queue", async () => {
    const view = await mountCommands([
      heavy({}),
      heavy({ source: "queue", entryId: "q1", pid: 50 }),
      heavy({ source: "queue", entryId: "s", name: "Checkpoint", stoppable: false }),
    ]);
    const stops = view.buttons("Stop");
    expect(stops).toHaveLength(2);
    await act(async () => stops[0]!.click());
    expect(mocks.commands.stopCommand).not.toHaveBeenCalled();
    await confirmAlert(0);
    expect(mocks.commands.stopCommand).toHaveBeenCalledWith({
      environmentId: "env",
      input: { pid: 12, startTimeMs: 34 },
    });
    await act(async () => stops[1]!.click());
    await confirmAlert(1);
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: "env",
      input: { id: "q1" },
    });
    expect(mocks.alert).toHaveBeenCalledTimes(2);

    mocks.commands.stopCommand!.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("That process is not a command an agent or terminal runs.")),
    });
    await act(async () => stops[0]!.click());
    await confirmAlert(2);
    expect(mocks.alert).toHaveBeenLastCalledWith(
      "Could not stop it",
      "That process is not a command an agent or terminal runs.",
    );
    await view.unmount();
  });

  it("disables Stop without permission", async () => {
    mocks.can = false;
    const view = await mountCommands([heavy({})]);
    expect(view.buttons("Stop")[0]!.disabled).toBe(true);
    await view.unmount();
  });

  it("keeps only the project's commands, matched by cwd or by their thread", async () => {
    mocks.shells = [{ environmentId: "env", id: "t7", projectId: "p1" }];
    const view = await mountCommands(
      [
        heavy({ name: "Here", threadId: null, cwd: "/work/app" }),
        heavy({ name: "Worktree", threadId: "t7", cwd: "/worktrees/app-2" }),
        heavy({ name: "Elsewhere", threadId: null, cwd: "/work/api" }),
      ],
      "p1",
    );
    expect(view.host.querySelector("section")?.getAttribute("aria-label")).toBe("Running now");
    const names = [...view.host.querySelectorAll("p")].map((row) => row.textContent?.split("|")[0]);
    expect(names).toEqual(["Here", "Worktree"]);
    expect(view.host.textContent).not.toContain("App Project");
    await view.unmount();

    const none = await mountCommands([heavy({ threadId: null, cwd: "/work/api" })], "p1");
    expect(none.host.innerHTML).toBe("");
    await none.unmount();
  });
});
