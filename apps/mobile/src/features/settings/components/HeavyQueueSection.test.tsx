import {
  HEAVY_QUEUE_DEFAULTS,
  heavyQueueLimitRange,
  type EnvironmentId,
  type HeavyQueueState,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    state: null as unknown as HeavyQueueState,
    can: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  },
}));

type A11y = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
};
vi.mock("react-native", () => ({
  View: (props: A11y) => (
    <div role={props.accessibilityRole} aria-label={props.accessibilityLabel}>
      {props.children}
    </div>
  ),
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../components/ui/NumberField", () => ({
  NumberField: (props: {
    label: string;
    min: number;
    max: number;
    value: number;
    disabled?: boolean;
    onValueChange: (value: number) => void;
  }) => (
    <input
      type="number"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(Number(event.target.value))}
    />
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("../../../state/entities", () => ({
  useProjects: () => [
    { id: "p1", environmentId: "env", workspaceRoot: "/work/app", title: "App Project" },
  ],
}));
vi.mock("../../../state/heavyQueue", () => {
  const command = (id: string) => ({ permissionAtom: () => "p", id });
  return {
    heavyQueueEnvironment: {
      move: command("move"),
      setEnabled: command("setEnabled"),
      setPaused: command("setPaused"),
      setRule: command("setRule"),
      setMaxRunning: command("setMaxRunning"),
      setClaudeHook: command("setClaudeHook"),
      setDeviceIdleMinutes: command("setDeviceIdleMinutes"),
      setMacMemoryFloorPercent: command("setMacMemoryFloorPercent"),
      setMacCpuCeilingPercent: command("setMacCpuCeilingPercent"),
      setHeavyOverLimitSeconds: command("setHeavyOverLimitSeconds"),
      setAdmissionLimits: command("setAdmissionLimits"),
    },
    useHeavyQueueState: () => mocks.state,
  };
});
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    (mocks.commands[command.id] ??= vi.fn(async () => ({ _tag: "Success", value: undefined }))),
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
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

import { HeavyQueueSection, type RunnerMode } from "./HeavyQueueSection";

const setup = (over: Partial<HeavyQueueState> = {}) => {
  mocks.state = {
    entries: [],
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

const RUNNER_OFF: RunnerMode = { enabled: false, where: "mac", everything: false };
const slowAgentJobs = { value: true, disabled: false, onChange: vi.fn() };
async function mount(runner = RUNNER_OFF, machine?: string) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HeavyQueueSection
        environmentId={"env" as EnvironmentId}
        runner={runner}
        slowAgentJobs={slowAgentJobs}
        {...(machine === undefined ? {} : { machine })}
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
  slowAgentJobs.disabled = false;
  mocks.commands = {};
  vi.clearAllMocks();
});

describe("HeavyQueueSection", () => {
  it("groups this Mac's slots and limits under This Mac; the over-the-limit time is shared", async () => {
    setup();
    const view = await mount({ enabled: true, where: "automatic", everything: false });
    const mac = view.host.querySelector('section[aria-label="This Mac"]')!;
    expect(mac.textContent).toContain("Run up to 3 at once on this Mac");
    for (const name of ["CPU limit", "Keep memory free"]) {
      expect(mac.querySelector(`input[aria-label="${name}"]`)).not.toBeNull();
    }
    expect(mac.querySelector('input[aria-label="Over the limit for"]')).toBeNull();
    expect(view.toggle("Over the limit for")).not.toBeNull();
    const slow = mac.querySelector<HTMLInputElement>(
      'input[aria-label="Slow down agent jobs when the Mac is busy"]',
    )!;
    expect(slow.checked).toBe(true);
    await act(async () => slow.click());
    expect(slowAgentJobs.onChange).toHaveBeenCalledWith(false);
    await view.unmount();
    // Queue off with Linux only: nothing of this Mac's applies, so the section goes.
    setup({ enabled: false });
    const linux = await mount({ enabled: true, where: "linux", everything: false }, "Studio");
    expect(linux.host.querySelector('section[aria-label="This Mac · Studio"]')).toBeNull();
    expect(
      linux.host.querySelector('section[aria-label="Heavy work queue · Studio"]'),
    ).not.toBeNull();
    expect(linux.toggle("Over the limit for")).not.toBeNull();
    // Only queued jobs are slowed, so the row goes with the queue.
    expect(linux.toggle("Slow down agent jobs when the Mac is busy")).toBeNull();
    await linux.unmount();
  });

  it("removes a project priority rule", async () => {
    setup({
      rules: [
        { root: "/work/app", priority: "last" },
        { root: "/gone", priority: "first" },
      ],
    });
    const view = await mount();
    await act(async () => view.button("App Project: Last").click());
    await act(async () => view.button("/gone: Always first").click());
    expect(mocks.commands.setRule!.mock.calls.map(([call]) => call.input)).toEqual([
      { root: "/work/app", priority: null },
      { root: "/gone", priority: null },
    ]);
    await view.unmount();
  });

  it("pauses the queue and changes the number of slots within limits", async () => {
    setup({ maxRunning: 1 });
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
    setup({ maxRunning: 8 });
    const full = await mount();
    expect(full.button("Allow one more").disabled).toBe(true);
    await act(async () => full.button("Allow one fewer").click());
    expect(mocks.commands.setMaxRunning).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { maxRunning: 7 },
    });
    await full.unmount();
  });

  it("switches the queue off and on, and hides pause, slots and rules while it is off", async () => {
    setup();
    const on = await mount();
    expect(on.toggle("Heavy work queue").checked).toBe(true);
    expect(on.toggle("Pause queue").disabled).toBe(false);
    await act(async () => on.toggle("Heavy work queue").click());
    expect(mocks.commands.setEnabled).toHaveBeenCalledWith({
      environmentId: "env",
      input: { enabled: false },
    });
    await on.unmount();

    setup({
      enabled: false,
      paused: true,
      maxRunning: 4,
      rules: [{ root: "/work/app", priority: "last" }],
    });
    const off = await mount();
    expect(off.host.textContent).not.toContain("Run up to 4 at once");
    expect(off.toggle("Pause queue")).toBeNull();
    for (const name of ["Allow one more", "Allow one fewer", "App Project: Last"]) {
      expect(off.button(name)).toBeUndefined();
    }
    // With the queue and the Runner off, no limit does anything.
    for (const name of ["CPU limit", "Keep memory free", "Over the limit for"]) {
      expect(off.toggle(name)).toBeNull();
    }
    expect(off.toggle("Heavy work queue")).toMatchObject({ disabled: false, checked: false });
    await act(async () => off.toggle("Heavy work queue").click());
    expect(mocks.commands.setEnabled).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: { enabled: true },
    });
    await off.unmount();

    // Hybrid without the queue still routes on the Mac limits.
    const hybrid = await mount({ enabled: true, where: "automatic", everything: false });
    for (const name of ["CPU limit", "Keep memory free", "Over the limit for"]) {
      expect(hybrid.toggle(name)).not.toBeNull();
    }
    await hybrid.unmount();
    const linux = await mount({ enabled: true, where: "linux", everything: false });
    expect(linux.toggle("CPU limit")).toBeNull();
    expect(linux.toggle("Over the limit for")).not.toBeNull();
    await linux.unmount();
  });

  it("resets a changed Mac limit to its default, like the sizes", async () => {
    setup({ macCpuCeilingPercent: 85 });
    const view = await mount();
    await act(async () => view.button("Use the default (70%)").click());
    expect(mocks.commands.setMacCpuCeilingPercent).toHaveBeenCalledWith({
      environmentId: "env",
      input: { macCpuCeilingPercent: 70 },
    });
    await view.unmount();
  });

  it("keeps a medium job's guess at or under a heavy job's while editing either", async () => {
    setup({ unseenHeavyMegabytes: 1536, unseenMediumMegabytes: 1024 });
    const view = await mount();
    expect(view.toggle("Memory guess for a new medium job").max).toBe("1536");
    expect(view.toggle("Memory guess for a new heavy job").min).toBe("1024");
    await view.unmount();
  });

  it("resets a memory guess only as far as the other one allows", async () => {
    setup({ unseenHeavyMegabytes: 256, unseenMediumMegabytes: 200 });
    const view = await mount();
    await act(async () => view.button("Use the default (256 MB)").click());
    expect(mocks.commands.setAdmissionLimits).toHaveBeenCalledWith({
      environmentId: "env",
      input: { unseenMediumMegabytes: 256 },
    });
    await view.unmount();
  });

  it("groups job sizing apart and resets a changed size to its default", async () => {
    setup({ lightJobMegabytes: 256 });
    const view = await mount();
    const sizing = view.host.querySelector('section[aria-label="Job sizing"]')!;
    expect(sizing.querySelectorAll("input")).toHaveLength(9);
    expect(view.host.textContent).toContain("unless it usually uses under 256 MB.");
    const resets = [...sizing.querySelectorAll("button")].filter((b) =>
      b.textContent?.startsWith("Use the default"),
    );
    expect(resets.map((b) => b.textContent)).toEqual(["Use the default (512 MB)"]);
    await act(async () => resets[0]!.click());
    expect(mocks.commands.setAdmissionLimits).toHaveBeenCalledWith({
      environmentId: "env",
      input: { lightJobMegabytes: 512 },
    });
    await view.unmount();
  });

  it.each([
    ["CPU limit", "macCpuCeilingPercent", "setMacCpuCeilingPercent", 85],
    ["Keep memory free", "macMemoryFloorPercent", "setMacMemoryFloorPercent", 30],
    ["Over the limit for", "heavyOverLimitSeconds", "setHeavyOverLimitSeconds", 45],
    ["Light job size", "lightJobMegabytes", "setAdmissionLimits", 300],
    ["Memory guess for a new heavy job", "unseenHeavyMegabytes", "setAdmissionLimits", 2048],
    ["Memory guess for a new medium job", "unseenMediumMegabytes", "setAdmissionLimits", 1024],
    ["Commands remembered", "historyCommands", "setAdmissionLimits", 200],
    ["Let smaller jobs pass for", "headPatienceMinutes", "setAdmissionLimits", 10],
    ["Quick job length", "quickSeconds", "setAdmissionLimits", 45],
    ["Quick jobs at once", "quickSlots", "setAdmissionLimits", 3],
    [
      "Idle job counts as running in the background after",
      "serviceIdleMinutes",
      "setAdmissionLimits",
      20,
    ],
    ["Keep a stopped agent's place for", "reclaimMinutes", "setAdmissionLimits", 15],
  ] as const)("sets this Mac's %s within its limits", async (label, key, command, next) => {
    setup({ [key]: next - 1 });
    const view = await mount();
    const field = view.toggle(label);
    expect(field).toMatchObject({
      value: String(next - 1),
      // The two memory guesses bound each other; the test above pins those numbers.
      min: String(heavyQueueLimitRange(key, mocks.state).min),
      max: String(heavyQueueLimitRange(key, mocks.state).max),
      disabled: false,
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        String(next),
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.commands[command]).toHaveBeenCalledWith({
      environmentId: "env",
      input: { [key]: next },
    });
    await view.unmount();
    mocks.can = false;
    const locked = await mount();
    expect(locked.toggle(label).disabled).toBe(true);
    await locked.unmount();
  });

  it("installs the Claude hook and picks the idle minutes", async () => {
    setup();
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

  it("says what the queue and the Runner do together", async () => {
    setup();
    const off = await mount();
    expect(off.host.textContent).toContain("Heavy jobs wait their turn on this Mac.");
    await off.unmount();
    const auto = await mount({ enabled: true, where: "automatic", everything: false });
    expect(auto.host.textContent).toContain(
      "Each job goes to the machine with the shorter queue. Neither starts a job past its own limits.",
    );
    await auto.unmount();
  });

  it("names the machine in the title", async () => {
    setup();
    const view = await mount(RUNNER_OFF, "Mac mini");
    expect(view.host.querySelector('[aria-label="Heavy work queue · Mac mini"]')).not.toBeNull();
    await view.unmount();
  });

  it("disables the actions without permission", async () => {
    mocks.can = false;
    // Settings writes have their own permission; without it the screen disables the row too.
    slowAgentJobs.disabled = true;
    setup({ rules: [{ root: "/work/app", priority: "last" }] });
    const view = await mount();
    expect(
      [...view.host.querySelectorAll("button, input")].every(
        (el) => (el as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    await view.unmount();
  });
});
