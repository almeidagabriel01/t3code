import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    selectDetail: vi.fn(),
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
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../state/decisions", () => ({ useOpenDecisionThreadKeys: () => new Set<string>() }));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => mocks.operable }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.visit }));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));

import { HomeNeedsYouSection } from "./HomeNeedsYouSection";

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
const render = (threads: EnvironmentThreadShell[], includeWorking = true) =>
  act(() =>
    root.render(
      <HomeNeedsYouSection
        threads={threads}
        now={now}
        includeWorking={includeWorking}
        gutter={4}
      />,
    ),
  );
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
  mocks.selectDetail.mockReset();
  mocks.visit.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.alert.mockReset();
  mocks.operable = new Set(["hub"]);
});
afterEach(() => act(() => root.unmount()));

describe("HomeNeedsYouSection", () => {
  it("renders nothing when no thread needs the user", () => {
    render([shell("quiet"), shell("assistant:a", { hasPendingApprovals: true })]);
    expect(container.textContent).toBe("");
  });

  it("lists needs-you, working, then unread, and opens a thread by id", async () => {
    const threads = [
      unread("done"),
      shell("busy", { runtime: { status: "running" } }),
      shell("ask", { hasPendingUserInput: true }),
    ];
    render(threads);
    expect(container.textContent).toMatch(
      /Needs you · 1.*Title ask.*Working · 1.*Title busy.*Unread · 1.*Title done/,
    );

    await press("Title ask");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "ask" },
    });

    render(threads, false);
    expect(container.textContent).not.toContain("Working");
  });

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
    render([unread("one"), shell("ask", { hasPendingUserInput: true })]);
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

  it("treats a server without visit times as having nothing unread", () => {
    render([shell("old", { latestRun, lastVisitedAt: undefined })]);
    expect(container.textContent).toBe("");
  });
});
