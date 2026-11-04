import type { KeyboardEvent, MouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  show: vi.fn(),
  hasApi: true,
  canArchive: true,
  toggleArchive: vi.fn(),
}));
vi.mock(import("../../hooks/useProjectGroupUpdate"), async (original) => ({
  ...(await original()),
  useProjectPin: (() => ({
    canPinProjectGroup: () => testState.canArchive,
    toggleProjectGroupArchive: testState.toggleArchive,
  })) as never,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() =>
    testState.hasApi ? { contextMenu: { show: testState.show } } : null) as never,
}));

import { useProjectRowMenu } from "./useProjectRowMenu";

const group = { archived: false, id: "alpha" } as never;
const rect = { left: 10, bottom: 40 };
const target = { getBoundingClientRect: () => rect };

function setup(options: { canArchive?: boolean; clicked?: string | null } = {}) {
  testState.show.mockReset().mockResolvedValue(options.clicked ?? null);
  testState.canArchive = options.canArchive ?? true;
  testState.toggleArchive.mockReset();
  const input = { openSettings: vi.fn(), toggleArchive: testState.toggleArchive };
  return { input, menu: useProjectRowMenu(input) };
}
const mouse = (extra: object = {}) =>
  ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: target,
    ...extra,
  }) as unknown as MouseEvent<HTMLElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
const key = (key: string, shiftKey = false) =>
  ({
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: target,
  }) as unknown as KeyboardEvent<HTMLInputElement> & { preventDefault: ReturnType<typeof vi.fn> };

beforeEach(() => {
  testState.hasApi = true;
});

describe("useProjectRowMenu", () => {
  it.each([
    {
      name: "right-click opens at the pointer",
      open: (menu: ReturnType<typeof setup>["menu"]) =>
        menu.onContextMenu(mouse({ clientX: 3, clientY: 4 }), group),
      position: { x: 3, y: 4 },
    },
    {
      name: "the ⋯ button opens under itself",
      open: (menu: ReturnType<typeof setup>["menu"]) => menu.onButtonClick(mouse(), group),
      position: { x: 10, y: 40 },
    },
    {
      name: "the ContextMenu key opens under the search field",
      open: (menu: ReturnType<typeof setup>["menu"]) => menu.onKeyDown(key("ContextMenu"), group),
      position: { x: 10, y: 40 },
    },
    {
      name: "Shift+F10 opens under the search field",
      open: (menu: ReturnType<typeof setup>["menu"]) => menu.onKeyDown(key("F10", true), group),
      position: { x: 10, y: 40 },
    },
  ])("$name with Project settings and Archive project", async ({ open, position }) => {
    const { menu } = setup();
    await open(menu);
    expect(testState.show).toHaveBeenCalledWith(
      [
        { id: "project-settings", label: "Project settings" },
        { id: "archive-project", label: "Archive project" },
      ],
      position,
    );
  });

  it("leaves other keys alone", async () => {
    const { menu } = setup();
    const event = key("Enter");
    await menu.onKeyDown(event, group);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(testState.show).not.toHaveBeenCalled();
  });

  it("hides Archive project when this connection cannot archive, and shows Unarchive when archived", async () => {
    const readOnly = setup({ canArchive: false });
    await readOnly.menu.onButtonClick(mouse(), group);
    expect(testState.show.mock.calls[0]![0]).toEqual([
      { id: "project-settings", label: "Project settings" },
    ]);

    const archived = setup();
    await archived.menu.onButtonClick(mouse(), { ...(group as object), archived: true } as never);
    expect(testState.show.mock.calls[0]![0].at(-1)).toEqual({
      id: "archive-project",
      label: "Unarchive project",
    });
  });

  it.each([
    { clicked: "archive-project", settings: 0, archive: 1 },
    { clicked: "project-settings", settings: 1, archive: 0 },
    { clicked: null, settings: 0, archive: 0 },
  ])("acts on the project it was opened for: $clicked", async ({ clicked, settings, archive }) => {
    const { menu, input } = setup({ clicked });
    await menu.onContextMenu(mouse({ clientX: 0, clientY: 0 }), group);
    expect(input.openSettings).toHaveBeenCalledTimes(settings);
    expect(input.toggleArchive).toHaveBeenCalledTimes(archive);
    if (archive) expect(input.toggleArchive).toHaveBeenCalledWith(group);
  });

  it("claims the event so the row does not also select", async () => {
    const { menu } = setup();
    const event = mouse({ clientX: 0, clientY: 0 });
    await menu.onContextMenu(event, group);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does nothing without a local api", async () => {
    testState.hasApi = false;
    const { menu } = setup();
    await menu.onButtonClick(mouse(), group);
    expect(testState.show).not.toHaveBeenCalled();
  });
});
