import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { threads: [] as unknown[], visit: vi.fn() },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/RelativeTime", () => ({
  RelativeTime: (props: { timestamp: string }) => `at ${props.timestamp}`,
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; meta?: ReactNode; accessory?: ReactNode }) => (
    <>
      {props.label}|{props.meta}
      {props.accessory}
    </>
  ),
}));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <i role="button" aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => new Set(["env"]) }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.visit }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env", label: "Studio Mac" }] }),
}));
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
vi.mock("../../state/decisions", () => ({
  useOpenDecisionThreadKeys: () => new Set(),
  useOpenDecisionAtByThreadKey: () => new Map(),
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => mocks.threads }));
vi.mock("../threads/use-thread-list-now", () => ({
  useThreadListNow: () => "2026-03-09T10:00:00.000Z",
}));

import { ProjectActivityView } from "./ProjectActivityView";

const run = (status: string, completedAt: string) => ({
  startedAt: null,
  requestedAt: null,
  completedAt,
  status,
});
const shell = (id: string, overrides: Record<string, unknown>) => ({
  environmentId: "env",
  id,
  title: `Thread ${id}`,
  projectId: "p1",
  createdAt: "2026-03-09T09:00:00.000Z",
  archivedAt: null,
  sideChatOf: null,
  lineage: { relationshipToParent: "none", parentThreadId: null },
  latestRun: null,
  runtime: null,
  lastVisitedAt: "2026-03-09T08:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  ...overrides,
});

async function mount(onOpenThread = vi.fn()) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ProjectActivityView
        environmentId={"env" as never}
        projectId="p1"
        onOpenThread={onOpenThread}
      />,
    ),
  );
  return { host, unmount: () => act(() => root.unmount()) };
}

describe("ProjectActivityView", () => {
  it("lists the project's runs newest first with their outcome, and opens one", async () => {
    mocks.threads = [
      shell("done", { latestRun: run("completed", "2026-03-09T09:10:00.000Z") }),
      shell("failed", { latestRun: run("failed", "2026-03-09T09:40:00.000Z") }),
      shell("asks", { hasPendingApprovals: true, updatedAt: "2026-03-09T09:30:00.000Z" }),
      shell("stopped", { latestRun: run("interrupted", "2026-03-09T09:20:00.000Z") }),
      shell("elsewhere", {
        projectId: "p2",
        latestRun: run("completed", "2026-03-09T09:50:00.000Z"),
      }),
    ];
    const onOpenThread = vi.fn();
    const view = await mount(onOpenThread);
    const rows = [...view.host.querySelectorAll("button")];
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Thread failed, Failed",
      "Thread asks, Needs you",
      "Thread stopped, Interrupted",
      "Thread done, Finished",
    ]);
    expect(rows[0]!.textContent).toBe(
      "Thread failed|Failed · Studio Mac · at 2026-03-09T09:40:00.000Z",
    );
    // A request has no Clear: it leaves when answered.
    expect(view.host.querySelector('[aria-label="Clear Thread asks"]')).toBeNull();
    mocks.visit.mockResolvedValue({ _tag: "Success" });
    await act(async () =>
      (view.host.querySelector('[aria-label="Clear Thread done"]') as HTMLElement).click(),
    );
    expect(mocks.visit).toHaveBeenCalledWith({
      environmentId: "env",
      input: { threadId: "done", visitedAt: "2026-03-09T09:10:00.000Z" },
    });
    act(() => rows[1]!.click());
    expect(onOpenThread).toHaveBeenCalledWith("asks");
    await view.unmount();
  });

  it("says when nothing in the project needs a look", async () => {
    mocks.threads = [shell("quiet", { lastVisitedAt: "2026-03-09T09:59:00.000Z" })];
    const view = await mount();
    expect(view.host.textContent).toContain("Nothing new in this project");
    await view.unmount();
  });
});
