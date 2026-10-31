import type { DecisionEntry } from "@t3tools/client-runtime/state/decisions";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    entries: { open: [], settled: [] } as { open: DecisionEntry[]; settled: DecisionEntry[] },
    selectDetail: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { onPress?: () => void; children?: ReactNode }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/decisions", () => ({ useDecisionEntries: () => mocks.entries }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("./DecisionCard", () => ({
  DecisionCard: (props: { decision: { title: string }; onOpenThread: () => void }) => (
    <button onClick={props.onOpenThread}>Open {props.decision.title}</button>
  ),
}));

import { HomeDecisionsSection } from "./HomeDecisionsSection";

const entry = (id: string, fromThreadId: string) =>
  ({
    environmentId: "hub",
    decision: { id, title: `Decision ${id}`, fromThreadId },
  }) as unknown as DecisionEntry;

let root: Root;
let container: HTMLDivElement;
const press = (label: string | RegExp) => {
  const found = Array.from(container.querySelectorAll("button")).find((button) =>
    typeof label === "string" ? button.textContent === label : label.test(button.textContent ?? ""),
  );
  if (!found) throw new Error(`Missing button: ${String(label)}`);
  act(() => found.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.selectDetail.mockReset();
  mocks.entries = { open: [], settled: [] };
});
afterEach(() => act(() => root.unmount()));

describe("HomeDecisionsSection", () => {
  it("renders nothing without decisions", () => {
    act(() => root.render(<HomeDecisionsSection gutter={4} />));
    expect(container.textContent).toBe("");
  });

  it("opens the requesting thread by id, for open and recent decisions alike", () => {
    mocks.entries = {
      open: [entry("a", "assistant:thread-1")],
      settled: [entry("b", "thread-2")],
    };
    act(() => root.render(<HomeDecisionsSection gutter={4} />));
    expect(container.textContent).toContain("Decisions · 1");
    expect(container.textContent).not.toContain("Open Decision b");

    press("Open Decision a");
    expect(mocks.selectDetail).toHaveBeenLastCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "assistant:thread-1" },
    });

    press(/Recent decisions \(1\)/);
    press("Open Decision b");
    expect(mocks.selectDetail).toHaveBeenLastCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "thread-2" },
    });

    press(/Recent decisions \(1\)/);
    expect(container.textContent).not.toContain("Open Decision b");
  });

  it("shows only the recent list when nothing is open", () => {
    mocks.entries = { open: [], settled: [entry("b", "thread-2")] };
    act(() => root.render(<HomeDecisionsSection gutter={4} />));
    expect(container.textContent).not.toContain("Decisions ·");
    expect(container.textContent).toContain("Recent decisions (1)");
  });
});
