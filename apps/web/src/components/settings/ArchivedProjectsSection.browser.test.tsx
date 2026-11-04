import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const testState = vi.hoisted(() => ({
  groups: [] as unknown[],
  canArchive: true,
  toggle: vi.fn(),
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { environmentIds: [], kind: "all" },
    groups: testState.groups,
    environments: [],
  })) as never,
}));
vi.mock(import("../../state/assistants"), async (original) => ({
  ...(await original()),
  useAssistantEntries: (() => ({ active: [], archived: [] })) as never,
}));
vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: (() => ({
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
  })) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({
    snapshots: [],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useProjectGroupUpdate"), async (original) => ({
  ...(await original()),
  useProjectPin: (() => ({
    canPinProjectGroup: () => testState.canArchive,
    toggleProjectGroupArchive: testState.toggle,
  })) as never,
}));

import { ArchivedProjectsSection, ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

function setup(canArchive = true) {
  testState.canArchive = canArchive;
  testState.toggle.mockReset();
  testState.groups = [
    { projectKey: "a", displayName: "Alpha", archived: true, memberProjectRefs: [] },
    { projectKey: "b", displayName: "Beta", archived: false, memberProjectRefs: [] },
  ];
}

describe("ArchivedProjectsSection", () => {
  it("lists only archived projects and unarchives one", async () => {
    setup();
    await using screen = await render(<ArchivedProjectsSection />, { router: false });
    await expect.element(screen.getByText("Alpha")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Beta");
    await userEvent.click(screen.getByRole("button", { name: "Unarchive project" }));
    expect(testState.toggle).toHaveBeenCalledWith(testState.groups[0]);
  });

  it("disables Unarchive on a read-only connection", async () => {
    setup(false);
    await using screen = await render(<ArchivedProjectsSection />, { router: false });
    await expect.element(screen.getByRole("button", { name: "Unarchive project" })).toBeDisabled();
  });

  it("renders nothing when no project is archived", async () => {
    setup();
    testState.groups = [];
    await using screen = await render(<ArchivedProjectsSection />, { router: false });
    expect(screen.container.textContent).toBe("");
  });

  it("shows archived projects ahead of the archived threads on the archive page", async () => {
    setup();
    await using screen = await render(<ArchivedThreadsPanel />);
    await expect.element(screen.getByText("Archived projects")).toBeVisible();
    await expect.element(screen.getByText("No archived threads")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Unarchive project" }));
    expect(testState.toggle).toHaveBeenCalledWith(testState.groups[0]);
  });
});
