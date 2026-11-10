import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Action = { id: string; title: string; subtitle?: string; subactions?: Action[] };
const captured = vi.hoisted(() => ({
  filterMenus: [] as Array<{
    label: string;
    actions: Action[];
    onSelect: (id: string) => void;
  }>,
}));

vi.mock("react-native", () => ({
  Pressable: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../layout/workspace/ListFilterMenu", () => ({
  ListFilterMenu: (props: { label: string; actions: Action[]; onSelect: (id: string) => void }) => {
    captured.filterMenus.push(props);
    return null;
  },
}));

import { ThreadListFilters } from "./ThreadListFilters";

const projects = [
  { key: "p1", label: "Alpha" },
  { key: "p2", label: "Beta" },
];
const base = {
  environments: [],
  projects,
  selectedEnvironmentId: null,
  onEnvironmentChange: vi.fn(),
  onProjectChange: vi.fn(),
};

async function mount(node: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  captured.filterMenus.length = 0;
  const root = createRoot(window.document.createElement("div"));
  await act(() => root.render(node));
  return () => act(() => root.unmount());
}

describe("ThreadListFilters archive action", () => {
  it.each([
    { selected: "p1", withHandler: true, offered: true },
    { selected: null, withHandler: true, offered: false },
    { selected: "p1", withHandler: false, offered: false },
  ])(
    "selected=$selected handler=$withHandler offered=$offered",
    async ({ selected, withHandler, offered }) => {
      const onArchiveProject = vi.fn();
      const unmount = await mount(
        <ThreadListFilters
          {...base}
          gutter={0}
          selectedProjectKey={selected}
          onArchiveProject={withHandler ? onArchiveProject : undefined}
        />,
      );
      const projectMenu = captured.filterMenus.find(
        (menu) => menu.label === (selected ? "Alpha" : "All projects"),
      )!;
      const archive = projectMenu.actions.find((action) => action.id === "archive-project");
      expect(archive !== undefined).toBe(offered);
      if (archive) {
        expect(archive).toMatchObject({ title: "Archive project", subtitle: "Alpha" });
        projectMenu.onSelect("archive-project");
        expect(onArchiveProject).toHaveBeenCalledOnce();
        expect(base.onProjectChange).not.toHaveBeenCalled();
      }
      await unmount();
    },
  );
});

describe("ThreadListFilters project selection", () => {
  it("still selects a project or all projects", async () => {
    const onProjectChange = vi.fn();
    const unmount = await mount(
      <ThreadListFilters
        {...base}
        gutter={0}
        selectedProjectKey={null}
        onProjectChange={onProjectChange}
      />,
    );
    const menu = captured.filterMenus.find((entry) => entry.label === "All projects")!;
    menu.onSelect(JSON.stringify("p2"));
    menu.onSelect("all");
    expect(onProjectChange.mock.calls).toEqual([["p2"], [null]]);
    await unmount();
  });
});
