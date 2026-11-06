import type { EnvironmentId, HeavyQueueEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    entries: [] as HeavyQueueEntry[],
    can: true,
    promote: vi.fn(),
    cancel: vi.fn(),
    alert: vi.fn(),
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
}));
vi.mock("../../../state/heavyQueue", () => ({
  heavyQueueEnvironment: {
    promote: { permissionAtom: () => "p", id: "promote" },
    cancel: { permissionAtom: () => "c", id: "cancel" },
  },
  useHeavyQueueEntries: () => mocks.entries,
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    command.id === "promote" ? mocks.promote : mocks.cancel,
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

import { HeavyQueueSection } from "./HeavyQueueSection";

const entry = (id: string, extra: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `cmd ${id}`,
  cwd: "/work/app/",
  createdAt: "2026-01-01T10:00:00.000Z",
  startedAt: null,
  ...extra,
});

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<HeavyQueueSection environmentId={"env" as EnvironmentId} />);
  });
  const buttons = () => [...host.querySelectorAll("button")];
  return { host, buttons, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.entries = [];
  mocks.can = true;
  mocks.titles = {};
  vi.clearAllMocks();
});

describe("HeavyQueueSection", () => {
  it("says so when nothing is queued", async () => {
    const view = await mount();
    expect(view.host.textContent).toBe("Nothing queued.");
    await view.unmount();
  });

  it("shows the running entry and waiters, offering Run next only past the first waiter", async () => {
    mocks.titles = { t1: "Fix login" };
    mocks.entries = [
      entry("a", { startedAt: "2026-01-01T10:00:00.000Z", threadId: "t1" }),
      entry("b"),
      entry("c", { threadId: "gone" }),
    ];
    const view = await mount();
    const rows = [...view.host.querySelectorAll("p")].map((row) => row.textContent);
    expect(rows[0]).toMatch(/^cmd a\|Fix login · Running since /);
    expect(rows.slice(1)).toEqual(["cmd b|app|#1", "cmd c|app|#2"]);
    expect(view.buttons().map((button) => button.textContent)).toEqual([
      "Remove",
      "Run next",
      "Remove",
    ]);
    await act(async () => view.buttons()[1]?.click());
    expect(mocks.promote).toHaveBeenCalledWith({ environmentId: "env", input: { id: "c" } });
    await view.unmount();
  });

  it("removes only after the alert is confirmed", async () => {
    mocks.entries = [entry("b")];
    const view = await mount();
    await act(async () => view.buttons()[0]?.click());
    expect(mocks.cancel).not.toHaveBeenCalled();
    const buttons = mocks.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((button) => button.text === "Remove")?.onPress?.();
    expect(mocks.cancel).toHaveBeenCalledWith({ environmentId: "env", input: { id: "b" } });
    await view.unmount();
  });

  it("disables the actions without permission", async () => {
    mocks.can = false;
    mocks.entries = [entry("b"), entry("c")];
    const view = await mount();
    expect(view.buttons().every((button) => button.disabled)).toBe(true);
    await view.unmount();
  });
});
