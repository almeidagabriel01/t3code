import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { select: vi.fn(), toggle: vi.fn(), expanded: false },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ProjectFavicon", () => ({
  ProjectFavicon: (props: { projectTitle: string }) => <i>{`icon:${props.projectTitle}`}</i>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <b>spinner</b>,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-03-09T10:10:00Z") }));
vi.mock("../../state/decisions", () => ({ useOpenDecisionThreadKeys: () => new Set<string>() }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "hub",
      id: "alpha",
      title: "Alpha",
      workspaceRoot: "/a",
      faviconPath: null,
      projectIcon: null,
    },
  ],
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{`chevron:${props.name}`}</s>,
}));
vi.mock("./useHomeSectionPreferences", () => ({
  useHomeSectionPreferences: () => ({
    agentsDoneExpanded: mocks.expanded,
    toggleAgentsDone: mocks.toggle,
  }),
}));
vi.mock("./UnreadActionsMenu", () => ({ UnreadActionsMenu: () => <i>unread-actions</i> }));
vi.mock("../threads/SubagentStatusDot", () => ({ SubagentStatusDot: () => <u>done-dot</u> }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.select,
}));

import { HomeAgentsSection } from "./HomeAgentsSection";

const now = "2026-03-09T10:10:00.000Z";
const shell = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    environmentId: "hub",
    id,
    projectId: "alpha",
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
const working = (id: string, startedAt: string | null, overrides: Record<string, unknown> = {}) =>
  shell(id, {
    runtime: { status: "running" },
    latestRun: startedAt ? { startedAt, completedAt: null, status: "running" } : null,
    ...overrides,
  });
const finished = (id: string) =>
  shell(id, {
    latestRun: { completedAt: "2026-03-09T10:05:00.000Z", status: "completed" },
    lastVisitedAt: "2026-03-09T10:04:00.000Z",
  });

let root: Root;
let container: HTMLDivElement;
const render = (threads: EnvironmentThreadShell[]) =>
  act(() => root.render(<HomeAgentsSection threads={threads} now={now} gutter={4} sidebar />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.select.mockReset();
  mocks.toggle.mockReset();
  mocks.expanded = false;
});
afterEach(() => act(() => root.unmount()));

describe("HomeAgentsSection", () => {
  it("renders nothing when no agent works or finished unseen", () => {
    render([
      shell("quiet"),
      shell("ask", { hasPendingUserInput: true }),
      working("assistant:a", null),
    ]);
    expect(container.textContent).toBe("");
  });

  it.each([
    ["minutes", "2026-03-09T10:05:00.000Z", "5m"],
    ["hours", "2026-03-09T07:40:00.000Z", "2h"],
    ["days", "2026-03-07T10:00:00.000Z", "2d"],
    ["an unparsable start", "not a date", ""],
  ])("shows elapsed time in %s", (_name, startedAt, label) => {
    render([working("busy", startedAt)]);
    expect(container.textContent).toContain(`spinner${label}`);
  });

  it("lists working then done agents on one line, and opens one by id", async () => {
    mocks.expanded = true;
    render([
      finished("fin"),
      working("busy", "2026-03-09T10:00:00.000Z"),
      working("lost", null, { projectId: "gone" }),
    ]);
    expect(container.textContent).toMatch(
      /Agents.*Working · 2.*icon:Alpha.*Title busy.*10m.*Title lost.*Done · 1.*chevron:chevron.down.*unread-actions.*Title fin.*done-dot/,
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[aria-label="Title fin, Alpha, finished"]',
    );
    await act(async () => row?.click());
    expect(mocks.select).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "fin" },
    });
    expect(
      container.querySelector('[aria-label="Title lost, Unknown project, working"]'),
    ).not.toBeNull();
  });

  it("keeps Done collapsed behind a chevron row and toggles it", async () => {
    render([finished("fin"), working("busy", "2026-03-09T10:00:00.000Z")]);
    expect(container.textContent).toContain("Title busy");
    expect(container.textContent).toContain("Done · 1chevron:chevron.right");
    expect(container.textContent).toContain("unread-actions");
    expect(container.textContent).not.toContain("Title fin");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Done, 1"]')?.click(),
    );
    expect(mocks.toggle).toHaveBeenCalledOnce();
  });
});
