import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    budgetState: undefined as undefined | "ok" | "warn" | "exceeded",
    spendQuery: vi.fn(),
    openEditor: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: () => null,
  toolAccessLabel: () => "Full access",
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: [
      {
        environmentId: "hub",
        assistant: { id: "a1", name: "Jarvis", handle: "jarvis", budget: {} },
      },
      {
        environmentId: "hub",
        assistant: { id: "a2", name: "Plain", handle: "plain", budget: null },
      },
    ],
    archived: [],
  }),
  useAssistantSpend: (environmentId: string, assistantId: string | null) => {
    mocks.spendQuery(environmentId, assistantId);
    return { data: assistantId ? { budget: { state: mocks.budgetState } } : null };
  },
}));

import { SettingsAssistantsRouteScreen } from "./SettingsAssistantsRouteScreen";

let root: Root;
let container: HTMLDivElement;
const labelOf = (name: string) =>
  Array.from(container.querySelectorAll("button"))
    .map((entry) => entry.getAttribute("aria-label") ?? "")
    .find((label) => label.startsWith(`${name},`));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.spendQuery.mockReset();
  mocks.openEditor.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("assistant list budget state", () => {
  it.each([
    ["exceeded", ", Limit reached"],
    ["warn", ", Near limit"],
    ["ok", ""],
  ] as const)("a %s limit reads %j on the row", (state, suffix) => {
    mocks.budgetState = state;
    act(() => root.render(<SettingsAssistantsRouteScreen />));
    const label = labelOf("Jarvis")!;
    expect(label).toBe(`Jarvis, @jarvis, Full access${suffix}`);
    expect(labelOf("Plain")).toBe("Plain, @plain, Full access");
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", "a1");
    expect(mocks.spendQuery).toHaveBeenCalledWith("hub", null);
  });
});
