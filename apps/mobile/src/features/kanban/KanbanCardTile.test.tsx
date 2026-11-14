import type { KanbanCard } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { KanbanCardTile } from "./KanbanCardTile";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { accessibilityLabel?: string; children?: ReactNode }) => (
    <button aria-label={props.accessibilityLabel}>{props.children}</button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string; accessibilityLabel?: string }) => (
    <i data-symbol={props.name} aria-label={props.accessibilityLabel} />
  ),
}));

const card = {
  id: "c1",
  number: 7,
  title: "Fix it",
  type: null,
  priority: "none",
  labelIds: [],
  checklist: [],
  blockedBy: [],
  dueAt: null,
  attachments: [],
  linkedThreadIds: [],
  problem: null,
} as unknown as KanbanCard;
const problem = { kind: "ci", count: 4, ownerName: null, previousCardNumber: null } as const;

describe("KanbanCardTile problem badge", () => {
  it.each([
    [{ ...problem, ignored: false }, "#7 Fix it, Seen 4 times", "exclamationmark.triangle"],
    [{ ...problem, count: 1, ignored: true }, "#7 Fix it, Ignored", "bell.slash"],
    [null, "#7 Fix it", null],
  ] as const)("%j", async (cardProblem, label, symbol) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <KanbanCardTile
          card={{ ...card, problem: cardProblem }}
          board={{ labels: [], templates: [] }}
          now={0}
          onPress={() => {}}
        />,
      ),
    );
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(label);
    const badgeSymbol = host.querySelector(
      '[data-symbol="exclamationmark.triangle"], [data-symbol="bell.slash"]',
    );
    expect(badgeSymbol?.getAttribute("data-symbol") ?? null).toBe(symbol);
    await act(async () => root.unmount());
  });
});
