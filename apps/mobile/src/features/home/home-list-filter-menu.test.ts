import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

const base = {
  environments: [],
  projects: [{ key: "p", label: "Alpha" }],
  selectedEnvironmentId: null as EnvironmentId | null,
  onEnvironmentChange: () => undefined,
  onProjectChange: () => undefined,
};

describe("buildHomeListFilterMenuItems archive action", () => {
  it("adds Archive project only for a selected project that can be archived", () => {
    const onArchiveProject = vi.fn();
    const titles = (
      selectedProjectKey: string | null,
      archive: typeof onArchiveProject | undefined,
    ) =>
      buildHomeListFilterMenuItems({ ...base, selectedProjectKey, onArchiveProject: archive }).map(
        (item) => item.title,
      );
    expect(titles("p", onArchiveProject)).toEqual(["Environment", "Project", "Archive project"]);
    expect(titles(null, onArchiveProject)).toEqual(["Environment", "Project"]);
    expect(titles("p", undefined)).toEqual(["Environment", "Project"]);

    const items = buildHomeListFilterMenuItems({
      ...base,
      selectedProjectKey: "p",
      onArchiveProject,
    });
    const action = items.at(-1);
    if (!action || !("onPress" in action)) throw new Error("expected an action");
    action.onPress();
    expect(onArchiveProject).toHaveBeenCalledOnce();
  });

  it("opens the selected project's settings from its own entry", () => {
    const onOpenProjectSettings = vi.fn();
    const items = buildHomeListFilterMenuItems({
      ...base,
      selectedProjectKey: "p",
      onOpenProjectSettings,
      onArchiveProject: vi.fn(),
    });
    expect(items.map((item) => item.title)).toEqual([
      "Environment",
      "Project",
      "Project settings",
      "Archive project",
    ]);
    const settings = items[2];
    if (!settings || !("onPress" in settings)) throw new Error("expected an action");
    settings.onPress();
    expect(onOpenProjectSettings).toHaveBeenCalledOnce();
    expect(
      buildHomeListFilterMenuItems({
        ...base,
        selectedProjectKey: null,
        onOpenProjectSettings,
      }).map((item) => item.title),
    ).toEqual(["Environment", "Project"]);
  });
});

describe("buildHomeListFilterMenuItems project subtitles", () => {
  const mac = EnvironmentId.make("mac");
  const pc = EnvironmentId.make("pc");
  const macDev = EnvironmentId.make("mac-dev");
  const distinctMachines = [
    { environmentId: mac, label: "Mac", displayUrl: "http://mac:3773/" },
    { environmentId: pc, label: "PC", displayUrl: "http://pc:3773/" },
  ];
  const sameNamedMachines = [
    { environmentId: mac, label: "Mac", displayUrl: "http://127.0.0.1:15500/" },
    { environmentId: macDev, label: "Mac", displayUrl: "http://127.0.0.1:14729/" },
    { environmentId: pc, label: "PC", displayUrl: "http://pc:3773/" },
  ];
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly environments?: ReadonlyArray<{
      environmentId: EnvironmentId;
      label: string;
      displayUrl?: string;
    }>;
    readonly projects: ReadonlyArray<{
      key: string;
      label: string;
      environmentIds?: EnvironmentId[];
    }>;
    readonly subtitles: ReadonlyArray<string | undefined>;
  }> = [
    {
      name: "unique names stay plain",
      projects: [
        { key: "a", label: "Alpha", environmentIds: [mac] },
        { key: "b", label: "Beta", environmentIds: [pc] },
      ],
      subtitles: [undefined, undefined],
    },
    {
      name: "same names name their machine",
      projects: [
        { key: "a", label: "Tirss", environmentIds: [mac] },
        { key: "b", label: "Tirss", environmentIds: [pc] },
        { key: "c", label: "Beta", environmentIds: [pc] },
      ],
      subtitles: ["Mac", "PC", undefined],
    },
    {
      name: "a group on several machines names each once",
      projects: [
        { key: "a", label: "Tirss", environmentIds: [mac, pc, mac] },
        { key: "b", label: "Tirss", environmentIds: [pc] },
      ],
      subtitles: ["Mac, PC", "PC"],
    },
    {
      name: "an unknown machine adds no subtitle",
      projects: [
        { key: "a", label: "Tirss", environmentIds: [EnvironmentId.make("gone")] },
        { key: "b", label: "Tirss" },
      ],
      subtitles: [undefined, undefined],
    },
    {
      name: "machines sharing a name are told apart by address",
      environments: sameNamedMachines,
      projects: [
        { key: "a", label: "Tirss", environmentIds: [mac] },
        { key: "b", label: "Tirss", environmentIds: [macDev] },
        { key: "c", label: "Tirss", environmentIds: [pc] },
      ],
      subtitles: ["http://127.0.0.1:15500/", "http://127.0.0.1:14729/", "PC"],
    },
    {
      name: "a shared machine name without an address keeps the name",
      environments: [
        { environmentId: mac, label: "Mac" },
        { environmentId: macDev, label: "Mac" },
      ],
      projects: [
        { key: "a", label: "Tirss", environmentIds: [mac] },
        { key: "b", label: "Tirss", environmentIds: [macDev] },
      ],
      subtitles: ["Mac", "Mac"],
    },
  ];

  it.each(cases)("$name", ({ environments = distinctMachines, projects, subtitles }) => {
    const section = buildHomeListFilterMenuItems({
      ...base,
      environments,
      projects,
      selectedProjectKey: null,
    }).find((item) => item.id === "project");
    if (!section || !("items" in section)) throw new Error("expected the project section");
    expect(
      section.items.slice(1).map((item) => ("subtitle" in item ? item.subtitle : undefined)),
    ).toEqual(subtitles);
  });
});

describe("buildHomeListFilterMenuItems environment subtitles", () => {
  it.each([
    {
      name: "distinct names stay plain",
      environments: [
        { environmentId: EnvironmentId.make("a"), label: "Mac", displayUrl: "http://a/" },
        { environmentId: EnvironmentId.make("b"), label: "PC", displayUrl: "http://b/" },
      ],
      subtitles: [undefined, undefined],
    },
    {
      name: "shared names show their address",
      environments: [
        { environmentId: EnvironmentId.make("a"), label: "Mac", displayUrl: "http://a/" },
        { environmentId: EnvironmentId.make("b"), label: "Mac", displayUrl: "http://b/" },
        { environmentId: EnvironmentId.make("c"), label: "PC", displayUrl: "http://c/" },
      ],
      subtitles: ["http://a/", "http://b/", undefined],
    },
  ])("$name", ({ environments, subtitles }) => {
    const section = buildHomeListFilterMenuItems({
      ...base,
      environments,
      projects: [],
      selectedProjectKey: null,
    }).find((item) => item.id === "environment");
    if (!section || !("items" in section)) throw new Error("expected the environment section");
    expect(
      section.items.slice(1).map((item) => ("subtitle" in item ? item.subtitle : undefined)),
    ).toEqual(subtitles);
  });
});
