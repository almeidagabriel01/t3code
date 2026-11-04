import type { ActivityEntry } from "@t3tools/client-runtime/state/thread-activity";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AgentsSidebarSection } from "./AgentsSidebarSection";

const state = vi.hoisted(() => ({
  entries: [] as ActivityEntry[],
  enabled: true,
  collapsed: false,
  doneCollapsed: false,
  update: vi.fn(),
}));
vi.mock("../activity/useActivity", () => ({ useActivityEntries: () => state.entries }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      environmentId: "env",
      id: "p1",
      title: "Alpha",
      workspaceRoot: "/a",
      faviconPath: null,
      projectIcon: { kind: "monogram", text: "AL", color: "blue" },
    },
  ],
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, boolean>) => unknown) =>
    select({
      sidebarShowAgentsSection: state.enabled,
      sidebarAgentsCollapsed: state.collapsed,
      sidebarAgentsDoneCollapsed: state.doneCollapsed,
    }),
  updateClientSettings: state.update,
}));
vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinuteMs: () => Date.parse("2026-03-09T10:10:00Z"),
}));

const entry = (id: string, rank: 1 | 2, at: string | null, projectId = "p1"): ActivityEntry => ({
  key: `env:${id}`,
  rank,
  thread: {
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: `Title ${id}`,
    createdAt: at ?? "2026-03-09T09:00:00.000Z",
    latestRun: at === null ? null : { startedAt: at, completedAt: at },
  } as unknown as ActivityEntry["thread"],
});

function setup(
  entries: ActivityEntry[],
  options: { enabled?: boolean; collapsed?: boolean; doneCollapsed?: boolean } = {},
) {
  state.entries = entries;
  state.enabled = options.enabled ?? true;
  state.collapsed = options.collapsed ?? false;
  state.doneCollapsed = options.doneCollapsed ?? false;
  state.update.mockClear();
}

const element = (onOpenThread = vi.fn(), routeThreadKey: string | null = null) => (
  <ul>
    <AgentsSidebarSection routeThreadKey={routeThreadKey} onOpenThread={onOpenThread} />
  </ul>
);

describe("AgentsSidebarSection", () => {
  it.each([
    { name: "has nothing to show", entries: [], options: {} },
    {
      name: "is switched off",
      entries: [entry("a", 1, "2026-03-09T10:00:00Z")],
      options: { enabled: false },
    },
  ])("renders nothing when it $name", async ({ entries, options }) => {
    setup(entries, options);
    await using screen = await render(element());
    expect(screen.container.textContent).toBe("");
  });

  it("lists working and done agents with their project, and opens one", async () => {
    setup([
      entry("a", 1, "2026-03-09T10:00:00Z"),
      entry("b", 2, "2026-03-09T10:05:00Z"),
      entry("c", 1, null, "gone"),
    ]);
    const onOpen = vi.fn();
    await using screen = await render(element(onOpen, "env:a"));
    const rows = screen.container.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-agent-row"]',
    );
    expect([...rows].map((row) => row.getAttribute("aria-label"))).toEqual([
      "Title a, Alpha, Working 10m",
      "Title c, Unknown project, Working 1h",
      "Title b, Alpha, Finished",
    ]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("page");
    expect(screen.container.textContent).toContain("Working · 2");
    expect(screen.container.textContent).toContain("Done · 1");
    await userEvent.click(rows[2]!);
    expect(onOpen).toHaveBeenCalledWith({ environmentId: "env", threadId: "b" });
  });

  it("collapses and expands through the setting", async () => {
    setup([entry("a", 1, "2026-03-09T10:00:00Z")]);
    await using screen = await render(element());
    await userEvent.click(screen.getByRole("button", { name: "Agents, 1" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAgentsCollapsed: true });
    setup([entry("a", 1, "2026-03-09T10:00:00Z")], { collapsed: true });
    await screen.rerender(element());
    expect(screen.container.querySelector('[data-testid="sidebar-agent-row"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Agents, 1" }));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarAgentsCollapsed: false });
  });

  it("folds the done agents behind one row and keeps the working ones in view", async () => {
    const entries = [entry("a", 1, "2026-03-09T10:00:00Z"), entry("b", 2, "2026-03-09T10:05:00Z")];
    setup(entries, { doneCollapsed: true });
    await using screen = await render(element());
    const labels = () =>
      [...screen.container.querySelectorAll<HTMLElement>('[data-testid="sidebar-agent-row"]')].map(
        (row) => row.getAttribute("aria-label"),
      );
    expect(labels()).toEqual(["Title a, Alpha, Working 10m"]);
    const done = screen.getByRole("button", { name: "Done · 1" });
    await expect.element(done).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(done);
    expect(state.update).toHaveBeenCalledWith({ sidebarAgentsDoneCollapsed: false });
    setup(entries, { doneCollapsed: false });
    await screen.rerender(element());
    expect(labels()).toEqual(["Title a, Alpha, Working 10m", "Title b, Alpha, Finished"]);
    await userEvent.click(screen.getByRole("button", { name: "Done · 1" }));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarAgentsDoneCollapsed: true });
  });

  it("caps a group and links the rest to Activity", async () => {
    setup(Array.from({ length: 8 }, (_, i) => entry(`t${i}`, 1, `2026-03-09T10:0${i}:00Z`)));
    await using screen = await render(element(), { router: "/" });
    expect(screen.container.querySelectorAll('[data-testid="sidebar-agent-row"]')).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(screen.router?.state.location.pathname).toBe("/activity");
  });
});
