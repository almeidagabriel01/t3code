import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type HeavyQueueState,
  type RunnerKey,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue: string;
  placeholder?: string;
  editable: boolean;
  onChangeText: (text: string) => void;
  onEndEditing: () => void;
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

async function mount(
  options: {
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
        settings={DEFAULT_SERVER_SETTINGS}
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
    [...host.querySelectorAll("button")].filter((b) => b.textContent === name)[nth];
  const input = (label: string) => mocks.inputs.get(label)!;
  const type = (label: string, text: string, end = true) =>
    act(() => {
      input(label).onChangeText(text);
      if (end) input(label).onEndEditing();
    });
  return {
    host,
    write,
    reset,
    button,
    input,
    type,
    unmount: () => act(() => root.unmount()),
  };
}

describe("RunnerSection", () => {
  it("writes each environment setting from its control", async () => {
    const view = await mount();
    await act(async () =>
      view.host.querySelector<HTMLInputElement>('input[aria-label="Use the Runner"]')!.click(),
    );
    await act(async () => view.button("Automatic")!.click());
    await act(async () => view.button("Wait for Linux", 0)!.click());
    await act(async () => view.button("Run on this Mac", 1)!.click());
    await act(async () => view.button("Cancel")!.click());
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerEnabled: true },
      { runnerWhere: "automatic" },
      { runnerUnavailable: "wait" },
      { runnerDropped: "mac" },
      { runnerDeadlineAction: "cancel" },
    ]);
    expect(view.button("This Mac")!.getAttribute("aria-checked")).toBe("true");
    expect(view.button("Use environment value")).toBeUndefined();
    expect(view.host.textContent).not.toContain("Inherited");
    await view.unmount();
  });

  it("shows which project fields inherit and resets an overridden one", async () => {
    const view = await mount({ projectSelected: true, overridden: ["runnerWhere"] });
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.startsWith("Where heavy work runs"))).toContain(
      "Set for this project.",
    );
    expect(rows.find((row) => row.startsWith("When Linux is offline"))).toContain(
      "Inherited from the environment.",
    );
    expect(view.input("Linux host")).toBeDefined();
    expect(view.host.textContent).toContain(
      "Environment-wide setting. Select All projects to change it.",
    );
    expect(view.host.querySelectorAll("button")).toSatisfy(
      (buttons: NodeListOf<HTMLButtonElement>) =>
        [...buttons].filter((b) => b.textContent === "Use environment value").length === 1,
    );
    await act(async () => view.button("Use environment value")!.click());
    expect(view.reset).toHaveBeenCalledWith("runnerWhere");
    await view.unmount();
  });

  it("rejects numbers outside the limits and saves only valid changes", async () => {
    const view = await mount();
    await view.type("Send to Linux after", "99");
    expect(view.host.textContent).toContain("Use 0 to 20 jobs.");
    await view.type("Send to Linux after", "", false);
    expect(view.host.textContent).toContain("Use a whole number of jobs.");
    await view.type("Send to Linux after", "3");
    expect(view.host.textContent).not.toContain("Use a whole number");
    await view.type("Send to Linux after", "0");
    await view.type("Jobs at once on Linux", "4");
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerOverflow: 0 },
      { runnerLinuxSlots: 4 },
    ]);
    await view.unmount();
  });

  it("normalizes pattern lists and rejects too many", async () => {
    const view = await mount();
    await view.type("Commands that may run on Linux", " vitest \n\nlint\nvitest");
    expect(view.write).toHaveBeenLastCalledWith({ runnerLinuxCommands: ["vitest", "lint"] });
    await view.type(
      "Commands that stay on this Mac",
      Array.from({ length: 51 }, (_, index) => `p${index}`).join("\n"),
    );
    expect(view.host.textContent).toContain("Keep it to 50 patterns.");
    expect(view.write).toHaveBeenCalledTimes(1);
    await view.unmount();
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
      mixed: ["runnerWhere", "runnerOverflow", "runnerMacOnly", "runnerHost"],
    });
    for (const name of ["This Mac", "Linux", "Automatic"]) {
      expect(view.button(name)!.getAttribute("aria-checked")).toBe("false");
    }
    expect(view.input("Send to Linux after")).toMatchObject({
      defaultValue: "",
      placeholder: "Mixed",
    });
    await view.type("Send to Linux after", "3");
    await view.type(
      "Commands that stay on this Mac",
      DEFAULT_SERVER_SETTINGS.runnerMacOnly.join("\n"),
    );
    await view.type("Linux host", DEFAULT_SERVER_SETTINGS.runnerHost);
    expect(view.write.mock.calls.map(([patch]) => patch)).toEqual([
      { runnerOverflow: 3 },
      { runnerMacOnly: DEFAULT_SERVER_SETTINGS.runnerMacOnly },
      { runnerHost: DEFAULT_SERVER_SETTINGS.runnerHost },
    ]);
    await view.unmount();
  });

  it("saves a valid unsent draft when the section closes", async () => {
    const view = await mount();
    await view.type("Wait for an answer", "8", false);
    await view.type("Check Linux every", "2", false);
    await view.unmount();
    expect(view.write.mock.calls).toEqual([[{ runnerAskMinutes: 8 }]]);
  });

  it("shows the mode line, the Linux status and locked fields", async () => {
    const linux = {
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
    const view = await mount({ linux, disabled: ["runnerEnabled", "runnerHost"] });
    expect(view.host.textContent).toContain("Heavy jobs wait their turn on this Mac.");
    expect(view.host.textContent).toContain("Linux offline: ssh timed out");
    expect(
      view.host.querySelector<HTMLInputElement>('input[aria-label="Use the Runner"]')!.disabled,
    ).toBe(true);
    expect(view.input("Linux host").editable).toBe(false);
    await view.unmount();
    const off = await mount();
    expect(off.host.textContent).not.toContain("Linux offline:");
    await off.unmount();
    // Each machine's queue section says it instead; one machine's status here would mislead.
    const several = await mount({ linux, severalMachines: true });
    expect(several.host.textContent).not.toContain("Linux offline:");
    expect(several.host.textContent).not.toContain("Heavy jobs wait their turn");
    await several.unmount();
  });
});
