import type { Assistant } from "@t3tools/contracts";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    spend: null as unknown,
    update: vi.fn(),
  },
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
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; accessory?: ReactNode }) => (
    <>
      {props.label}
      {props.accessory}
    </>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.selected}
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
  useAssistantEntries: () => ({ active: [], archived: [] }),
  useAssistantSpend: () => ({ data: mocks.spend }),
  useAssistantsEnvironmentIds: () => ["hub"],
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("./AssistantSchedulesSection", () => ({ AssistantSchedulesSection: () => null }));
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
  mocks.update.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

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
