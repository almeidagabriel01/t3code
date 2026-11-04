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
  useSettingsScope: (() => ({ groups: testState.groups })) as never,
}));
vi.mock(import("../../hooks/useProjectGroupUpdate"), async (original) => ({
  ...(await original()),
  useProjectPin: (() => ({
    canPinProjectGroup: () => testState.canArchive,
    toggleProjectGroupArchive: testState.toggle,
  })) as never,
}));

import { ArchivedProjectsSection } from "./ArchivedThreadsPanel";

function setup(canArchive = true) {
  testState.canArchive = canArchive;
  testState.toggle.mockReset();
  testState.groups = [
    { projectKey: "a", displayName: "Alpha", archived: true },
    { projectKey: "b", displayName: "Beta", archived: false },
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
});
