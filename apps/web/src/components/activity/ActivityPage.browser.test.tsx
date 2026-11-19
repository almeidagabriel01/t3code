import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { ActivityPage } from "./ActivityPage";

const env = EnvironmentId.make("environment-one");
const needsYou = makeThreadFixture({
  id: ThreadId.make("thread-b"),
  environmentId: env,
  title: "Needs approval",
  hasPendingApprovals: true,
});

const task = makeThreadFixture({
  id: ThreadId.make("thread-task"),
  environmentId: env,
  title: "Ada's task",
  runtime: {
    status: "running",
    activeRunId: null,
    providerInstanceId: null,
    providerName: null,
    lastError: null,
    updatedAt: "2026-11-19T10:00:00.000Z",
  },
} as never);
const { mocks } = vi.hoisted(() => ({
  mocks: { shells: [] as unknown[], working: [] as unknown[] },
}));

vi.mock("../sidebar/useSidebarZones", () => ({ useWorkingRows: () => mocks.working }));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => mocks.shells,
  useProjects: () => [],
  useDelegatedUnderParent: () => new Set(),
  useQuietThreadShell: () => null,
}));
vi.mock("../../state/decisions", () => ({
  useDecisionEntries: () => ({ open: [] }),
  useOpenDecisionThreadKeys: () => new Set(),
}));
vi.mock("./useActivityRead", () => ({
  useActivityRead: () => ({
    canMarkAllRead: false,
    canClearRead: false,
    markAllRead: vi.fn(),
    clearRead: vi.fn(),
  }),
}));
vi.mock("../decisions/DecisionsSection", () => ({ DecisionsSection: () => null }));
vi.mock("../ChatView", () => ({ default: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));

const workingRow = (thread: typeof task, line: string) => ({
  item: {
    key: `${thread.environmentId}:${thread.id}`,
    consumer: { kind: "assistant", threadId: thread.id, environmentId: env },
    ownerAssistantId: "ada",
    shell: thread,
  },
  title: thread.title,
  line,
});

describe("ActivityPage", () => {
  it("draws exactly the working set, with who and where, once each, in the count", async () => {
    // Running, but not in `workingItems`: Activity counts the selector's set, not its own.
    const loose = makeThreadFixture({
      id: ThreadId.make("thread-loose"),
      environmentId: env,
      title: "Loose",
      runtime: task.runtime,
    });
    mocks.shells = [needsYou, task, loose];
    const helper = makeThreadFixture({
      id: ThreadId.make("assistant:ada:1"),
      environmentId: env,
      title: "Ada",
    });
    mocks.working = [workingRow(task, "Ada · VPS"), workingRow(helper, "Ada · Mac")];
    await using screen = await render(<ActivityPage />, { router: "/activity" });
    await expect.element(screen.getByRole("heading", { name: "Working (2)" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Ada's task\s*Ada · VPS/ }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Ada\s*Ada · Mac/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Ada's task/ }).elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Loose/ }).elements()).toHaveLength(0);
    await expect.element(screen.getByText("1 need you · 2 working")).toBeVisible();
  });

  it("remembers a thread opened from Activity as the place Close returns to", async () => {
    mocks.shells = [needsYou];
    mocks.working = [];
    await using screen = await render(<ActivityPage />, { router: "/activity" });
    const router = screen.router!;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await userEvent.click(screen.getByRole("button", { name: /Needs approval/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close activity" }));
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe("/environment-one/thread-b"),
    );
  });
});
