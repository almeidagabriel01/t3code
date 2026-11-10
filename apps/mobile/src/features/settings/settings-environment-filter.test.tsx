import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    environments: [] as unknown[],
    projects: [] as unknown[],
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  buildProjectGroups: ({
    projects,
  }: {
    projects: { id: string; environmentId: string; title: string; archived?: boolean }[];
  }) =>
    projects.map((project) => ({
      key: project.id,
      label: project.title,
      archived: project.archived ?? false,
      members: [{ project }],
    })),
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  ENVIRONMENT_MACHINE_SYMBOLS: {},
}));

import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import {
  SettingsEnvironmentFilterProvider,
  useSettingsEnvironmentFilter,
} from "./settings-environment-filter";

type Menu = ReturnType<typeof useSettingsEnvironmentMenu>;
type MenuItem = NonNullable<Menu["items"]>[number];

let latest: { menu: Menu; filter: ReturnType<typeof useSettingsEnvironmentFilter> };

function Probe(props: { readonly sink: typeof setLatest }) {
  props.sink({ menu: useSettingsEnvironmentMenu(), filter: useSettingsEnvironmentFilter() });
  return null;
}
const setLatest = (next: typeof latest) => {
  latest = next;
};

function connected(environmentId: string) {
  return {
    environmentId,
    label: environmentId,
    displayUrl: null,
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: { machine: "server" } } },
  };
}

const projectsSection = () =>
  latest.menu.items!.find((item) => item.id === "projects") as Extract<
    MenuItem,
    { items: unknown }
  >;
const projectItems = () =>
  projectsSection().items.map((item) => item as { id: string; title: string; selected?: boolean });
const press = (id: string) =>
  act(() =>
    (projectItems().find((item) => item.id === id) as unknown as { onPress: () => void }).onPress(),
  );

let root: Root;
const render = (open: boolean) =>
  act(() =>
    root.render(
      <SettingsEnvironmentFilterProvider open={open}>
        <Probe sink={setLatest} />
      </SettingsEnvironmentFilterProvider>,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.environments = [connected("local")];
  mocks.projects = [
    { id: "a", environmentId: "local", title: "Alpha" },
    { id: "b", environmentId: "local", title: "Beta", archived: true },
  ];
});
afterEach(() => act(() => root.unmount()));

describe("settings project filter", () => {
  it("selects several projects and clears them with All projects", () => {
    render(true);
    const sections = latest.menu.items!.flatMap((item) => ("items" in item ? item.items : []));
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.every((item) => "keepsMenuPresented" in item && item.keepsMenuPresented)).toBe(
      true,
    );
    expect(projectsSection().title).toBe("All projects");
    expect(latest.menu.icon).toBe("line.3.horizontal.decrease");

    press("project:a");
    expect(projectsSection().title).toBe("Alpha");
    press("project:b");

    expect(projectsSection().title).toBe("2 projects");
    expect(latest.menu.icon).toBe("line.3.horizontal.decrease.circle.fill");
    expect(projectItems().map((item) => [item.id, item.selected])).toEqual([
      ["project:all", false],
      ["project:a", true],
      ["project:b", true],
    ]);
    expect(projectItems()[2]!.title).toBe("Beta · Archived");
    expect(
      latest.filter.selectedProjects?.map((project) => (project as { id: string }).id),
    ).toEqual(["a", "b"]);

    press("project:a");
    expect(projectsSection().title).toBe("Beta");

    press("project:all");
    expect(projectsSection().title).toBe("All projects");
    expect(latest.filter.selectedProjects).toBeNull();
  });

  it("falls back to every project when the last one is unticked", () => {
    render(true);
    press("project:a");
    press("project:a");
    expect(latest.filter.selectedProjectKeys).toBeNull();
  });

  it("ignores keys of projects that no longer exist", () => {
    render(true);
    act(() => latest.filter.toggleProject("gone"));
    expect(projectsSection().title).toBe("Unavailable project");
    expect(latest.filter.selectedProjects).toEqual([]);

    press("project:a");
    expect(projectsSection().title).toBe("Alpha");
  });

  it("reads the latest selection synchronously for work that outlives the render", () => {
    render(true);
    act(() => {
      latest.filter.toggleProject("a");
      latest.filter.toggleProject("b");
    });
    expect([...latest.filter.getSelectedProjectKeys()!]).toEqual(["a", "b"]);
  });

  it("resets the selection when Settings closes", () => {
    render(true);
    press("project:a");
    render(false);
    expect(latest.filter.selectedProjectKeys).toBeNull();
  });

  it("offers only projects of the selected environments", () => {
    mocks.environments = [connected("local"), connected("remote")];
    mocks.projects = [
      { id: "a", environmentId: "local", title: "Alpha" },
      { id: "r", environmentId: "remote", title: "Remote" },
    ];
    render(true);
    act(() => latest.filter.toggleEnvironment("remote" as never));
    expect(projectItems().map((item) => item.id)).toEqual(["project:all", "project:a"]);
  });
});
