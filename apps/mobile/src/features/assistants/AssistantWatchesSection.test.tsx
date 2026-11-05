import type { AutonomyWatch } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    watches: [] as unknown[],
    error: null as string | null,
    canAct: true,
    navigate: vi.fn(),
    alert: vi.fn(),
    setEnabled: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <>
      {props.label} {props.description}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: {
    label: string;
    description?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label} {props.description}
    </button>
  ),
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      checked={props.value}
      onChange={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../state/autonomy", () => ({
  useAutonomyWatches: () => ({ data: { watches: mocks.watches }, error: mocks.error }),
  useAutonomyWatchActions: () => ({ canAct: mocks.canAct, setEnabled: mocks.setEnabled }),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { assistantWatchEditorAtom } from "./assistantWatchEditor";
import { AssistantWatchesSection } from "./AssistantWatchesSection";

const watch = (id: string, patch: Partial<AutonomyWatch> = {}) =>
  ({
    id,
    assistantId: "a1",
    title: `Watch ${id}`,
    filter: { event: "pr_checks_failed", projectId: "p1", prNumber: 42 },
    instruction: "Fix it",
    oneShot: false,
    enabled: true,
    expiresAt: null,
    lastTriggeredAt: null,
    ...patch,
  }) as unknown as AutonomyWatch;
const projects = [{ id: "p1" as never, label: "Alpha" }];

let root: Root;
let container: HTMLDivElement;
const render = (notifies = true) =>
  act(() =>
    root.render(
      <AssistantWatchesSection
        key={String(notifies)}
        environmentId={"hub" as never}
        assistantId={"a1" as never}
        notifies={notifies}
        projects={projects}
      />,
    ),
  );
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.navigate.mockReset();
  mocks.alert.mockReset();
  mocks.setEnabled.mockReset().mockResolvedValue({ ok: true });
  mocks.canAct = true;
  mocks.error = null;
  mocks.watches = [
    watch("1"),
    watch("2", { assistantId: "other" as never }),
    watch("3", {
      enabled: false,
      filter: { event: "run_failed" },
      lastTriggeredAt: "2031-01-01T09:00:00.000Z",
    } as Partial<AutonomyWatch>),
  ];
  appAtomRegistry.set(assistantWatchEditorAtom, null);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-01-01T12:00:00.000Z"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("assistant watches", () => {
  it("lists only this assistant's watches with a human summary", () => {
    render();
    expect(container.textContent).toContain("PR checks fail · Alpha · PR #42 · Never triggered");
    expect(container.textContent).toContain("A run fails · Last triggered 3h ago · Paused");
    expect(container.textContent).not.toContain("Watch 2");
    expect(container.textContent).not.toContain("No watches yet");
  });

  it("says when its notifications are off", () => {
    render(false);
    expect(container.textContent).toContain("only wake it when its notifications are on");
  });

  it("opens the form on the watch, or on an empty one", () => {
    render();
    act(() => button("Edit Watch 1").click());
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsAssistantWatch");
    expect(appAtomRegistry.get(assistantWatchEditorAtom)).toMatchObject({
      environmentId: "hub",
      assistantId: "a1",
      projects,
      current: { id: "1", title: "Watch 1", prNumber: "42" },
    });
    act(() => button("New watch").click());
    expect(appAtomRegistry.get(assistantWatchEditorAtom)?.current).toMatchObject({
      id: null,
      title: "",
    });
  });

  it("pauses and resumes through the switch, and reports a refusal", async () => {
    render();
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Watch 1 enabled"]')!.click(),
    );
    expect(mocks.setEnabled).toHaveBeenCalledWith("1", false);
    mocks.setEnabled.mockResolvedValue({ ok: false, message: "Nope" });
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Watch 3 enabled"]')!.click(),
    );
    expect(mocks.setEnabled).toHaveBeenLastCalledWith("3", true);
    expect(mocks.alert).toHaveBeenCalledWith("Could not update the watch", "Nope");
  });

  it("explains an empty list, a load failure, and a read-only session", () => {
    mocks.watches = [];
    render();
    expect(container.textContent).toContain("No watches yet");

    mocks.error = "offline";
    mocks.canAct = false;
    render(false);
    expect(container.textContent).toContain("Could not load watches: offline");
    expect(container.textContent).not.toContain("No watches yet");
    expect((button("New watch") as HTMLButtonElement).disabled).toBe(true);
  });
});
