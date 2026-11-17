import type { HeavyNotice, HeavyNoticesMode } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({ mocks: { notices: null as unknown } }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { absoluteFill: {} },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-screens", () => ({
  FullWindowOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/Toast", () => ({
  Toast: (props: {
    message: string;
    description?: string;
    tone?: string;
    action?: { label: string; onPress: () => void };
    onDismiss?: () => void;
  }) => (
    <div role="alert" data-tone={props.tone}>
      <p>{props.message}</p>
      <p>{props.description}</p>
      <button onClick={props.action?.onPress}>{props.action?.label}</button>
      <button onClick={props.onDismiss}>Dismiss</button>
    </div>
  ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env 1" }] }),
}));
vi.mock("../../state/heavyQueue", () => ({
  heavyQueueEnvironment: { notices: () => mocks.notices },
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    description?: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-checked={props.selected} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; children: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));

import { HeavyNoticesSection } from "../settings/components/HeavyNoticesSection";
import { HeavyNoticeHost } from "./HeavyNoticeHost";

const notice = (patch: Partial<HeavyNotice>): HeavyNotice => ({
  id: "n-1",
  tone: "error",
  title: "pnpm test failed on Linux",
  description: "Exit code 1",
  machine: "linux",
  threadId: "thread-1",
  ...patch,
});

async function mount(batch: ReadonlyArray<HeavyNotice>) {
  mocks.notices = Atom.make(AsyncResult.success(batch));
  const navigate = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<HeavyNoticeHost navigate={navigate} />));
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name);
  return { host, navigate, button, unmount: () => act(() => root.unmount()) };
}

describe("HeavyNoticeHost", () => {
  it("shows a job's notice and opens its thread", async () => {
    const view = await mount([notice({})]);
    expect(view.host.textContent).toContain("pnpm test failed on Linux");
    expect(view.host.textContent).toContain("Exit code 1");
    expect(view.host.querySelector("[role=alert]")?.getAttribute("data-tone")).toBe("danger");
    await act(async () => view.button("Open thread")!.click());
    expect(view.navigate).toHaveBeenCalledWith("/threads/env%201/thread-1");
    expect(view.host.querySelector("[role=alert]")).toBeNull();
    view.unmount();
  });

  it("opens the heavy work queue from a grouped notice, and hides after its time", async () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const view = await mount([
      notice({
        id: "n-2",
        tone: "info",
        title: "3 jobs moved to this Mac",
        description: "Linux is unavailable",
        threadId: null,
      }),
    ]);
    expect(view.host.querySelector("[role=alert]")?.getAttribute("data-tone")).toBe("info");
    await act(async () => view.button("Heavy work")!.click());
    expect(view.navigate).toHaveBeenCalledWith("/settings/maintenance");
    view.unmount();

    // The same notice is never shown twice; a new one is, until its time runs out.
    const again = await mount([
      notice({ id: "n-2", tone: "info", title: "3 jobs moved to this Mac", threadId: null }),
      notice({ id: "n-3", tone: "warning", title: "Linux went offline", threadId: null }),
    ]);
    expect(again.host.textContent).toContain("Linux went offline");
    expect(again.host.querySelector("[role=alert]")?.getAttribute("data-tone")).toBe("warning");
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(again.host.querySelector("[role=alert]")).toBeNull();
    again.unmount();
  });

  it("swiping it away clears it", async () => {
    const view = await mount([notice({ id: "n-4" })]);
    await act(async () => view.button("Dismiss")!.click());
    expect(view.host.querySelector("[role=alert]")).toBeNull();
    view.unmount();
  });
});

describe("HeavyNoticesSection", () => {
  it("marks the chosen mode and writes a new one", async () => {
    const onChange = vi.fn<(mode: HeavyNoticesMode) => void>();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(<HeavyNoticesSection value="unexpected" disabled={false} onChange={onChange} />),
    );
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([
      ["Problems and unexpected moves", "true"],
      ["Every machine change", "false"],
      ["Problems only", "false"],
      ["Off", "false"],
    ]);
    await act(async () => buttons[3]!.click());
    expect(onChange).toHaveBeenCalledWith("off");
    act(() => root.unmount());
  });
});
