import type { EnvironmentId, HeavyQueueEntry, HeavyQueueState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    state: null as unknown as HeavyQueueState,
    can: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
    alert: vi.fn(),
    selectDetail: vi.fn(),
    titles: {} as Record<string, string>,
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
      : { title: mocks.titles[ref.threadId] },
  useProjects: () => [{ environmentId: "env", workspaceRoot: "/work/app", title: "App Project" }],
}));
vi.mock("../../../state/heavyQueue", () => {
  const command = (id: string) => ({ permissionAtom: () => "p", id });
  return {
    heavyQueueEnvironment: {
      move: command("move"),
      cancel: command("cancel"),
      setPaused: command("setPaused"),
      setRule: command("setRule"),
      setMaxRunning: command("setMaxRunning"),
    },
    useHeavyQueueState: () => mocks.state,
  };
});
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => (mocks.commands[command.id] ??= vi.fn()),
}));
vi.mock("../../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; detail?: string }) => (
    <p>{[props.label, props.description, props.detail].filter(Boolean).join("|")}</p>
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

import { HeavyQueueSection } from "./HeavyQueueSection";

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
    paused: false,
    rules: [],
    maxRunning: 3,
    reasons: {},
    room: true,
    machine: null,
    ...over,
  };
};

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<HeavyQueueSection environmentId={"env" as EnvironmentId} />);
  });
  const button = (name: string, nth = 0) =>
    [...host.querySelectorAll("button")].filter((b) => b.textContent === name)[nth]!;
  return { host, button, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.can = true;
  mocks.titles = {};
  mocks.commands = {};
  vi.clearAllMocks();
});

describe("HeavyQueueSection", () => {
  it("says so when nothing is queued, with the slot summary", async () => {
    setup([]);
    const view = await mount();
    expect(view.host.textContent).toContain("0 of 3 running · Mac has room");
    expect(view.host.textContent).toContain("Nothing queued.");
    await view.unmount();
  });

  it("describes each entry with project, thread, rule, reason and note", async () => {
    mocks.titles = { t1: "Fix login" };
    setup(
      [
        entry("a", { startedAt: NOW, threadId: "t1" }),
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
    expect(rows.find((row) => row?.startsWith("cmd a"))).toMatch(
      /^cmd a\|App Project · Fix login · Always first · Running /,
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
    expect(mocks.commands.setRule.mock.calls.map(([call]) => call.input)).toEqual([
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
    await act(async () => view.host.querySelector<HTMLInputElement>("input")!.click());
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

  it("disables the actions without permission", async () => {
    mocks.can = false;
    setup([entry("b"), entry("c")]);
    const view = await mount();
    expect(
      [...view.host.querySelectorAll("button, input")].every(
        (el) => (el as HTMLButtonElement).disabled,
      ),
    ).toBe(true);
    await view.unmount();
  });
});
