import {
  DEFAULT_SERVER_SETTINGS,
  RUNNER_DEFAULTS,
  type EnvironmentId,
  type HeavyQueueState,
  type RunnerKey,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue?: string;
  value?: string;
  placeholder?: string;
  editable: boolean;
  onChangeText: (text: string) => void;
  onEndEditing?: () => void;
  onSubmitEditing?: () => void;
};

const { mocks } = vi.hoisted(() => ({
  mocks: {
    state: null as unknown as Pick<HeavyQueueState, "enabled" | "paused" | "linux">,
    inputs: new Map<string, InputProps>(),
  },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    mocks.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../state/heavyQueue", () => ({ useHeavyQueueState: () => mocks.state }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>{[props.label, props.description].filter(Boolean).join("|")}</p>
  ),
}));
vi.mock("../../../components/ui/SegmentedControl", () => ({
  SegmentedControl: (props: {
    options: ReadonlyArray<{ value: string; label: string }>;
    selected: string | null;
    onSelect: (value: string) => void;
  }) =>
    props.options.map((option) => (
      <button
        key={option.value}
        role="radio"
        aria-checked={option.value === props.selected}
        onClick={() => props.onSelect(option.value)}
      >
        {option.label}
      </button>
    )),
}));
vi.mock("../../../components/ui/Chip", () => ({
  Chip: (props: {
    label: string;
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.accessibilityLabel}
    </button>
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

import { RunnerSection, type RunnerProjectKey } from "./RunnerSection";

const RUNNER_ON: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, runnerEnabled: true };
const LINUX = {
  host: "remoto",
  online: false,
  slots: 2,
  running: 0,
  load1: null,
  cpuCount: null,
  availableMemoryBytes: null,
  totalMemoryBytes: null,
  error: "ssh timed out",
};

async function mount(
  options: {
    settings?: Partial<ServerSettings>;
    projectSelected?: boolean;
    overridden?: ReadonlyArray<RunnerProjectKey>;
    mixed?: ReadonlyArray<RunnerKey>;
    disabled?: ReadonlyArray<RunnerKey>;
    linux?: HeavyQueueState["linux"];
    severalMachines?: boolean;
  } = {},
) {
  mocks.state = { enabled: true, paused: false, linux: options.linux ?? null };
  mocks.inputs.clear();
  const write = vi.fn();
  const reset = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <RunnerSection
        environmentId={"env" as EnvironmentId}
        settings={{ ...RUNNER_ON, ...options.settings }}
        projectSelected={options.projectSelected ?? false}
        overridden={(key) => options.overridden?.includes(key) ?? false}
        mixed={(key) => options.mixed?.includes(key) ?? false}
        disabledFor={(key) => options.disabled?.includes(key) ?? false}
        write={write}
        reset={reset}
        severalMachines={options.severalMachines ?? false}
      />,
    );
  });
  const button = (name: string, nth = 0) =>
    [...host.querySelectorAll("button")].filter(
      (b) => b.textContent === name || b.getAttribute("aria-label") === name,
    )[nth];
  const sections = () =>
    [...host.querySelectorAll("section")].map((section) => section.getAttribute("aria-label"));
  const input = (label: string) => mocks.inputs.get(label);
  const type = (label: string, text: string, end = true) =>
    act(() => {
      input(label)!.onChangeText(text);
      if (end) input(label)!.onEndEditing?.();
    });
  const click = (name: string, nth = 0) => act(async () => button(name, nth)!.click());
  return {
    host,
    write,
    reset,
    button,
    sections,
    input,
    type,
    click,
    unmount: () => act(() => root.unmount()),
  };
}

describe("RunnerSection", () => {
  it("writes each environment setting from its control", async () => {
    const view = await mount();
    await act(async () =>
      view.host.querySelector<HTMLInputElement>('input[aria-label="Use the Runner"]')!.click(),
    );
    await view.click("Hybrid");
    await view.click("Wait for Linux", 0);
    await view.click("Run on this Mac", 1);
    await view.click("Cancel");
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerEnabled: false },
      { runnerWhere: "automatic" },
      { runnerUnavailable: "wait" },
      { runnerDropped: "mac" },
      { runnerDeadlineAction: "cancel" },
    ]);
    // From all-local to all-remote, with the picked mode explained under it.
    expect(
      [...view.host.querySelectorAll('[role="radio"]')].map((b) => [
        b.textContent,
        b.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["This Mac", "true"],
      ["Mac first", "false"],
      ["Hybrid", "false"],
      ["Linux", "false"],
    ]);
    expect(view.host.textContent).toContain(
      "Everything runs on this Mac. A job's menu can still send it to Linux.",
    );
    expect(view.sections()).toEqual([
      "Runner",
      "Where jobs run",
      "Linux PC",
      "If Linux is unavailable",
      "Connection checks",
    ]);
    expect(view.button("Use environment value")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Inherited");
    await view.unmount();
  });

  it.each([
    {
      name: "the Runner is off: only its switch",
      settings: { runnerEnabled: false },
      mixed: [],
      sections: ["Runner"],
      hidden: ["Linux host"],
      visible: [],
    },
    {
      name: "the Runner differs across targets: every field, since some target uses it",
      settings: { runnerEnabled: false, runnerWhere: "mac" as const },
      mixed: ["runnerEnabled" as const, "runnerWhere" as const],
      sections: [
        "Runner",
        "Where jobs run",
        "Linux PC",
        "If Linux is unavailable",
        "Connection checks",
      ],
      hidden: [],
      visible: ["Can run on Linux", "Wait for an answer"],
    },
    {
      name: "jobs stay on this Mac: no Linux command list",
      settings: { runnerWhere: "mac" as const },
      mixed: [],
      sections: [
        "Runner",
        "Where jobs run",
        "Linux PC",
        "If Linux is unavailable",
        "Connection checks",
      ],
      hidden: ["Can run on Linux"],
      visible: ["Always on this Mac", "Linux host"],
    },
    {
      name: "neither policy asks: no wait or deadline",
      settings: {
        runnerWhere: "linux" as const,
        runnerUnavailable: "mac" as const,
        runnerDropped: "wait" as const,
      },
      mixed: [],
      sections: [
        "Runner",
        "Where jobs run",
        "Linux PC",
        "If Linux is unavailable",
        "Connection checks",
      ],
      hidden: ["Wait for an answer", "If nobody answers"],
      visible: ["Can run on Linux", "When Linux is offline"],
    },
  ])(
    "hides what does nothing when $name",
    async ({ settings, mixed, sections, hidden, visible }) => {
      const view = await mount({ settings, mixed });
      expect(view.sections()).toEqual(sections);
      const text = view.host.textContent ?? "";
      const present = (label: string) => text.includes(label) || view.input(label) !== undefined;
      for (const label of hidden) expect(present(label), label).toBe(false);
      for (const label of visible) expect(present(label), label).toBe(true);
      await view.unmount();
    },
  );

  it("shows which project fields inherit and resets an overridden one", async () => {
    const view = await mount({ projectSelected: true, overridden: ["runnerWhere"] });
    expect(view.host.textContent).toContain(
      "Everything runs on this Mac. A job's menu can still send it to Linux. Set for this project.",
    );
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.startsWith("When Linux is offline"))).toContain(
      "Inherited from the environment.",
    );
    expect(view.input("Linux host")).toBeDefined();
    expect(view.host.textContent).toContain(
      "Environment-wide setting. Select All projects to change it.",
    );
    expect(
      [...view.host.querySelectorAll("button")].filter(
        (b) => b.textContent === "Use environment value",
      ),
    ).toHaveLength(1);
    await view.click("Use environment value");
    expect(view.reset).toHaveBeenCalledWith("runnerWhere");
    await view.unmount();
  });

  it("rejects numbers outside the limits, shows units and saves only valid changes", async () => {
    const view = await mount();
    await view.type("CPU limit", "101");
    expect(view.host.textContent).toContain("Use 20 to 100 percent.");
    await view.type("CPU limit", "", false);
    expect(view.host.textContent).toContain("Use a whole number of percent.");
    await view.type("CPU limit", "70");
    expect(view.host.textContent).not.toContain("Use a whole number");
    await view.type("CPU limit", "85");
    await view.type("Jobs at once on Linux", "4");
    await view.type("Keep memory free", "25");
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerLinuxCpuCeilingPercent: 85 },
      { runnerLinuxSlots: 4 },
      { runnerLinuxMemoryFloorPercent: 25 },
    ]);
    const units = [...view.host.querySelectorAll("span")].map((span) => span.textContent);
    expect(units).toEqual(expect.arrayContaining(["%", "jobs", "min"]));
    await view.unmount();
  });

  it.each([
    {
      name: "Mac first asks after how many jobs",
      settings: { runnerWhere: "macFirst" as const },
      shown: ["Send to Linux after"],
      hidden: ["Everything"],
    },
    {
      name: "Linux can send everything",
      settings: { runnerWhere: "linux" as const },
      shown: ["Everything"],
      hidden: ["Send to Linux after"],
    },
    {
      name: "disagreeing modes show both",
      settings: {},
      mixed: ["runnerWhere" as const],
      shown: ["Everything", "Send to Linux after"],
      hidden: [],
    },
    {
      name: "Hybrid shows neither",
      settings: { runnerWhere: "automatic" as const },
      shown: [],
      hidden: ["Everything", "Send to Linux after"],
    },
  ])("$name", async ({ settings, mixed, shown, hidden }) => {
    const view = await mount({ settings, ...(mixed === undefined ? {} : { mixed }) });
    const present = (label: string) =>
      view.input(label) !== undefined ||
      view.host.querySelector(`input[aria-label="${label}"]`) !== null;
    for (const label of shown) expect(present(label), label).toBe(true);
    for (const label of hidden) expect(present(label), label).toBe(false);
    expect(present("Bring results back")).toBe(true);
    await view.unmount();
  });

  it("saves the Mac first threshold, Everything, bring-back and failure choices", async () => {
    const view = await mount({ settings: { runnerWhere: "macFirst" } });
    await view.type("Send to Linux after", "6");
    await view.type("Send to Linux after", "33");
    expect(view.host.textContent).toContain("Use 1 to 32 jobs.");
    await act(async () =>
      view.host.querySelector<HTMLInputElement>('input[aria-label="Bring results back"]')!.click(),
    );
    await view.click("Tell the agent");
    expect(view.button("Tell the agent")!.getAttribute("aria-checked")).toBe("true");
    await view.click("Wait for Linux", 1);
    await view.unmount();
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerMacFirstAfter: 6 },
      { runnerBringBack: true },
      { runnerDropped: "agent" },
      { runnerDropped: "wait" },
    ]);

    const linux = await mount({
      settings: { runnerWhere: "linux", runnerLinuxEverything: true },
      disabled: ["runnerLinuxEverything"],
    });
    const everything = linux.host.querySelector<HTMLInputElement>(
      'input[aria-label="Everything"]',
    )!;
    expect(everything.checked).toBe(true);
    expect(everything.disabled).toBe(true);
    await linux.unmount();
  });

  it("folds the connection checks until asked", async () => {
    const view = await mount();
    expect(view.input("Check Linux every")).toBeUndefined();
    await view.click("Show connection checks");
    for (const label of [
      "Check Linux every",
      "Mark Linux offline after",
      "SSH timeout",
      "Wait for a stopped job",
    ]) {
      expect(view.input(label), label).toBeDefined();
    }
    await view.type("SSH timeout", "12");
    expect(view.write).toHaveBeenLastCalledWith({ runnerSshTimeoutSeconds: 12 });
    await view.click("Hide connection checks");
    expect(view.host.textContent).toContain("Show connection checks");
    await view.unmount();
  });

  it("adds and removes commands as chips, and rejects too many", async () => {
    const view = await mount({
      settings: {
        runnerWhere: "linux",
        runnerLinuxCommands: ["vitest", "lint"],
        runnerMacOnly: [],
      },
    });
    await view.click("Remove lint from Can run on Linux");
    expect(view.write).toHaveBeenLastCalledWith({ runnerLinuxCommands: ["vitest"] });
    expect(view.button("Add to Can run on Linux")!.disabled).toBe(true);
    await act(() => view.input("Add a command to Can run on Linux")!.onChangeText("  jest "));
    expect(view.input("Add a command to Can run on Linux")!.value).toBe("  jest ");
    await view.click("Add to Can run on Linux");
    expect(view.write).toHaveBeenLastCalledWith({
      runnerLinuxCommands: ["vitest", "lint", "jest"],
    });
    expect(view.input("Add a command to Can run on Linux")!.value).toBe("");
    // A command already listed clears the field without saving again.
    await act(() => view.input("Add a command to Can run on Linux")!.onChangeText("vitest"));
    await act(() => view.input("Add a command to Can run on Linux")!.onSubmitEditing!());
    expect(view.write).toHaveBeenCalledTimes(2);
    expect(view.input("Add a command to Can run on Linux")!.value).toBe("");
    await act(() => view.input("Add a command to Can run on Linux")!.onSubmitEditing!());
    expect(view.write).toHaveBeenCalledTimes(2);
    await view.unmount();

    const full = await mount({
      settings: { runnerMacOnly: Array.from({ length: 50 }, (_, index) => `p${index}`) },
    });
    await act(() => full.input("Add a command to Always on this Mac")!.onChangeText("p50"));
    await full.click("Add to Always on this Mac");
    expect(full.host.textContent).toContain("Keep it to 50 patterns.");
    expect(full.write).not.toHaveBeenCalled();
    expect(full.input("Add a command to Always on this Mac")!.value).toBe("p50");
    await full.unmount();
  });

  it("checks the SSH host before saving it", async () => {
    const view = await mount();
    await view.type("Linux host", "-oProxyCommand");
    expect(view.host.textContent).toContain("A host cannot start with a dash.");
    await view.type("Linux host", " box ");
    expect(view.write.mock.calls).toEqual([[{ runnerHost: "box" }]]);
    await view.unmount();
  });

  it("selects nothing for values the selected targets disagree on, and saves any valid entry", async () => {
    const view = await mount({
      mixed: ["runnerWhere", "runnerLinuxSlots", "runnerMacOnly", "runnerHost"],
    });
    for (const name of ["This Mac", "Linux", "Hybrid"]) {
      expect(view.button(name)!.getAttribute("aria-checked")).toBe("false");
    }
    expect(view.host.textContent).toContain(
      "Mac first fills this Mac, then sends the rest to Linux.",
    );
    expect(view.input("Jobs at once on Linux")).toMatchObject({
      defaultValue: "",
      placeholder: "Mixed",
    });
    expect(view.input("Add a command to Always on this Mac")).toBeUndefined();
    expect(view.host.textContent).toContain("Differs across the selected targets.");
    await view.type("Jobs at once on Linux", "3");
    await view.click("Use the defaults everywhere");
    await view.type("Linux host", DEFAULT_SERVER_SETTINGS.runnerHost);
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerLinuxSlots: 3 },
      { runnerMacOnly: RUNNER_DEFAULTS.runnerMacOnly },
      { runnerHost: DEFAULT_SERVER_SETTINGS.runnerHost },
    ]);
    await view.unmount();
  });

  it("saves a valid unsent draft when the section closes", async () => {
    const view = await mount();
    await view.type("Wait for an answer", "8", false);
    await view.type("Jobs at once on Linux", "99", false);
    await view.unmount();
    expect(view.write.mock.calls).toEqual([[{ runnerAskMinutes: 8 }]]);
  });

  it("shows the Linux status under the host, and locks fields it cannot change", async () => {
    const view = await mount({
      linux: LINUX,
      disabled: ["runnerEnabled", "runnerHost", "runnerMacOnly"],
    });
    expect(view.host.textContent).toContain("Linux offline: ssh timed out");
    // The queue section says what the queue and the Runner do together.
    expect(view.host.textContent).not.toContain("wait their turn");
    expect(
      view.host.querySelector<HTMLInputElement>('input[aria-label="Use the Runner"]')!.disabled,
    ).toBe(true);
    expect(view.input("Linux host")!.editable).toBe(false);
    expect(view.input("Add a command to Always on this Mac")!.editable).toBe(false);
    expect(view.button("Remove xcodebuild from Always on this Mac")!.disabled).toBe(true);
    await view.unmount();
    const off = await mount();
    expect(off.host.textContent).not.toContain("Linux offline:");
    await off.unmount();
    // Each machine's queue section says it instead; one machine's status here would mislead.
    const several = await mount({ linux: LINUX, severalMachines: true });
    expect(several.host.textContent).not.toContain("Linux offline:");
    await several.unmount();
  });
});
