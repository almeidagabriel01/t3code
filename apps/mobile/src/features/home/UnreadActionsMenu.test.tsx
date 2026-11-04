import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    visit: vi.fn(),
    alert: vi.fn(),
    operable: new Set<string>(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: { onPress?: () => void; children?: ReactNode }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => mocks.operable }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.visit }));

import { UnreadActionsMenu } from "./UnreadActionsMenu";

const now = "2026-03-09T10:10:00.000Z";
const latestRun = { completedAt: "2026-03-09T10:05:00.000Z", status: "completed" };
const shell = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    environmentId: "hub",
    id,
    projectId: "project",
    title: `Title ${id}`,
    createdAt: "2026-03-09T09:00:00.000Z",
    archivedAt: null,
    sideChatOf: null,
    lineage: { relationshipToParent: "none", parentThreadId: null },
    latestRun: null,
    runtime: null,
    lastVisitedAt: "2026-03-09T10:06:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;
const unread = (id: string) => shell(id, { latestRun, lastVisitedAt: "2026-03-09T10:04:00.000Z" });

let root: Root;
let container: HTMLDivElement;
const render = (threads: EnvironmentThreadShell[]) =>
  act(() => root.render(<UnreadActionsMenu threads={threads} now={now} />));
const press = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find((button) =>
    (button.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return act(async () => found.click());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.visit.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.alert.mockReset();
  mocks.operable = new Set(["hub"]);
});
afterEach(() => act(() => root.unmount()));

describe("UnreadActionsMenu", () => {
  it("marks unread threads read, and reports a failed visit", async () => {
    render([unread("one"), unread("two")]);
    await press("Mark all as read");
    expect(mocks.visit).toHaveBeenCalledTimes(2);
    expect(mocks.visit).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { threadId: "one", visitedAt: now },
    });
    expect(mocks.alert).not.toHaveBeenCalled();

    mocks.visit.mockResolvedValue({ _tag: "Failure", cause: Cause.interrupt() });
    await press("Mark all as read");
    expect(mocks.alert).not.toHaveBeenCalled();

    mocks.visit.mockResolvedValue({ _tag: "Failure", cause: Cause.fail("nope") });
    await press("Mark all as read");
    expect(mocks.alert).toHaveBeenCalledTimes(1);

    mocks.operable = new Set();
    render([unread("one"), unread("two")]);
    mocks.visit.mockClear();
    await press("Mark all as read");
    expect(mocks.visit).not.toHaveBeenCalled();
  });

  it("clears read threads through the same visits, skipping what it cannot operate", async () => {
    render([unread("one"), shell("seen", { latestRun })]);
    await press("Clear read");
    expect(mocks.visit).toHaveBeenCalledTimes(1);
    expect(mocks.visit).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { threadId: "one", visitedAt: now },
    });

    mocks.operable = new Set();
    render([unread("one")]);
    mocks.visit.mockClear();
    await press("Clear read");
    expect(mocks.visit).not.toHaveBeenCalled();
  });
});
