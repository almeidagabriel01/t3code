import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { migratePersistedRightPanelState, useRightPanelStore } from "./rightPanelStore";
import {
  closeThreadTab,
  commitRouteTab,
  dropThreadTab,
  focusThreadTabGroup,
  layoutGeometry,
  mergeThreadTabGroups,
  parsePersistedWorkspace,
  reconcileRouteTab,
  resolveTabDropZone,
  resolveTabInsertIndex,
  restoreThreadTab,
  setThreadSplitRatio,
  type ThreadTabLayout,
  threadTabPlacement,
  threadTabRow,
  type ThreadTabWorkspace,
  useThreadTabsStore,
} from "./threadTabsStore";

const ids = () => {
  let next = 0;
  return () => `n${++next}`;
};
const one = (tabs: string[], active = tabs[0]!): ThreadTabWorkspace => ({
  groups: [{ id: "main", tabs, active }],
  layout: { type: "leaf", groupId: "main" },
  focusedGroupId: "main",
});
const leaf = (groupId: string) => ({ type: "leaf", groupId }) as const;
/** main (a, b) | g2 (c) side by side. */
const sideBySide = (focused = "main"): ThreadTabWorkspace => ({
  groups: [
    { id: "main", tabs: ["a", "b"], active: "a" },
    { id: "g2", tabs: ["c"], active: "c" },
  ],
  layout: {
    type: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.5,
    first: leaf("main"),
    second: leaf("g2"),
  },
  focusedGroupId: focused,
});

describe("reconcileRouteTab", () => {
  it("starts a workspace with the routed thread", () => {
    expect(reconcileRouteTab(undefined, "a")).toEqual(one(["a"]));
  });

  it("opens a new thread after the focused group's active tab", () => {
    expect(reconcileRouteTab(one(["a", "b"]), "c").groups[0]).toEqual({
      id: "main",
      tabs: ["a", "c", "b"],
      active: "c",
    });
    expect(reconcileRouteTab(sideBySide("g2"), "d").groups[1]?.tabs).toEqual(["c", "d"]);
  });

  it("activates and focuses the group that already has the thread", () => {
    const next = reconcileRouteTab(sideBySide("g2"), "b");
    expect(next.focusedGroupId).toBe("main");
    expect(next.groups[0]?.active).toBe("b");
    const settled = sideBySide();
    expect(reconcileRouteTab(settled, "a")).toBe(settled);
  });
});

/** Project p's split: main (p1) | g2 (q1) | g3 (q2), a q thread being any key starting with q. */
const mixed = (focused: string, recent?: string[]): ThreadTabWorkspace => ({
  groups: [
    { id: "main", tabs: ["p1"], active: "p1" },
    { id: "g2", tabs: ["q1"], active: "q1" },
    { id: "g3", tabs: ["q2"], active: "q2" },
  ],
  layout: {
    type: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.5,
    first: leaf("main"),
    second: {
      type: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("g2"),
      second: leaf("g3"),
    },
  },
  focusedGroupId: focused,
  ...(recent ? { recentGroupIds: recent } : {}),
});
const projectOf = (key: string) => (key.startsWith("q") ? "Q" : key.startsWith("p") ? "P" : "R");

describe("threadTabPlacement", () => {
  it.each<
    [
      string,
      Record<string, ThreadTabWorkspace>,
      string | null,
      string,
      string | null,
      object | null,
    ]
  >([
    [
      "the focused group when it shows the project",
      { P: mixed("g3", ["g3", "g2"]) },
      "P",
      "qn",
      "Q",
      { key: "P", groupId: "g3" },
    ],
    [
      "the q group focused last when another group has focus",
      { P: mixed("main", ["main", "g3", "g2"]) },
      "P",
      "qn",
      "Q",
      { key: "P", groupId: "g3" },
    ],
    [
      "the first q group in reading order without a focus history",
      { P: mixed("main") },
      "P",
      "qn",
      "Q",
      { key: "P", groupId: "g2" },
    ],
    [
      "its own project's tabs when no group in view shows it",
      { P: mixed("main") },
      "P",
      "rn",
      "R",
      { key: "R" },
    ],
    [
      "its own project's focused group, unchanged, when that is the view",
      { P: mixed("main") },
      "P",
      "pn",
      "P",
      { key: "P" },
    ],
    [
      "its own project's tabs when the visible layout closed",
      { Q: one(["q9"]) },
      "P",
      "qn",
      "Q",
      { key: "Q" },
    ],
    [
      "its own project's tabs when nothing was shown yet",
      { P: mixed("main") },
      null,
      "qn",
      "Q",
      { key: "Q" },
    ],
    [
      "the layout already holding its tab",
      { P: mixed("main"), Q: one(["q9"]) },
      "P",
      "q9",
      "Q",
      { key: "Q" },
    ],
    [
      "the split holding its tab rather than its own project's",
      { P: mixed("main"), Q: one(["q9"]) },
      "Q",
      "q1",
      "Q",
      { key: "P" },
    ],
    ["no tabs for a thread that opens without them", { P: mixed("main") }, "P", "qn", null, null],
  ])(
    "puts an untabbed or tabbed thread in %s",
    (_name, byProject, visibleKey, threadKey, ownKey, expected) => {
      expect(threadTabPlacement({ byProject, visibleKey }, threadKey, ownKey, projectOf)).toEqual(
        expected,
      );
    },
  );

  it("opens the pick in that group, keeps the split and shows that layout", () => {
    useThreadTabsStore.setState({
      byProject: { P: mixed("main", ["main", "g3"]) },
      visibleKey: "P",
    });
    commitRouteTab("qn", "Q", projectOf);
    const { byProject, visibleKey } = useThreadTabsStore.getState();
    expect(visibleKey).toBe("P");
    expect(byProject.Q).toBeUndefined();
    expect(byProject.P?.focusedGroupId).toBe("g3");
    expect(byProject.P?.recentGroupIds).toEqual(["g3", "main"]);
    expect(byProject.P?.groups[2]).toEqual({
      id: "g3",
      tabs: ["q2", "qn"],
      active: "qn",
      returnTo: { tab: "qn", to: "q2" },
    });
    commitRouteTab("rn", "R", projectOf);
    expect(useThreadTabsStore.getState().visibleKey).toBe("R");
    expect(useThreadTabsStore.getState().byProject.R).toMatchObject(one(["rn"]));
    const settled = useThreadTabsStore.getState();
    commitRouteTab("rn", "R", projectOf);
    commitRouteTab("x", null, projectOf);
    expect(useThreadTabsStore.getState()).toBe(settled);
  });

  it("reopens a closed tab in its group, else its layout's focused group, never in two layouts", () => {
    useThreadTabsStore.setState({
      byProject: { P: mixed("main"), Q: one(["qn"]) },
      visibleKey: "P",
    });
    restoreThreadTab("P", "g3", "qn");
    expect(useThreadTabsStore.getState().byProject.P?.groups[2]).toEqual({
      id: "g3",
      tabs: ["q2", "qn"],
      active: "qn",
    });
    expect(useThreadTabsStore.getState().byProject.Q).toBeUndefined();
    restoreThreadTab("P", "gone", "p2");
    expect(useThreadTabsStore.getState().byProject.P?.groups[2]?.tabs).toEqual(["q2", "qn", "p2"]);
    const settled = useThreadTabsStore.getState();
    restoreThreadTab("P", "g3", "p2");
    restoreThreadTab("missing", "main", "p3");
    expect(useThreadTabsStore.getState()).toBe(settled);
  });
});

describe("dropThreadTab", () => {
  it.each([
    ["left", "horizontal", ["n1", "main"]],
    ["right", "horizontal", ["main", "n1"]],
    ["up", "vertical", ["n1", "main"]],
    ["down", "vertical", ["main", "n1"]],
  ] as const)("an edge drop on %s splits a new group off", (zone, direction, order) => {
    const next = dropThreadTab(one(["a", "b"]), "b", { groupId: "main", zone }, ids());
    const layout = next?.layout as Extract<ThreadTabLayout, { type: "split" }>;
    expect(layout.direction).toBe(direction);
    expect([layout.first, layout.second]).toEqual(order.map(leaf));
    expect(next?.groups).toEqual([
      { id: "main", tabs: ["a"], active: "a" },
      { id: "n1", tabs: ["b"], active: "b" },
    ]);
    expect(next?.focusedGroupId).toBe("n1");
  });

  it("splits a thread dragged in from the sidebar beside the group", () => {
    const next = dropThreadTab(one(["a"]), "x", { groupId: "main", zone: "right" }, ids());
    expect(next?.groups.map((group) => group.tabs)).toEqual([["a"], ["x"]]);
  });

  it("does nothing for a group's only tab split off itself, or a drop back in place", () => {
    expect(dropThreadTab(one(["a"]), "a", { groupId: "main", zone: "left" }, ids())).toBeNull();
    expect(dropThreadTab(one(["a", "b"]), "a", { groupId: "main", index: 0 }, ids())).toBeNull();
    expect(dropThreadTab(one(["a"]), "a", { groupId: "gone", zone: "center" }, ids())).toBeNull();
  });

  it.each([
    [0, ["c", "a", "b"]],
    [1, ["a", "c", "b"]],
    [3, ["a", "b", "c"]],
  ])("reorders within a strip to index %s", (index, tabs) => {
    const next = dropThreadTab(one(["a", "b", "c"]), "c", { groupId: "main", index }, ids());
    expect(next?.groups[0]).toEqual({ id: "main", tabs, active: "c" });
  });

  it("counts a forward index with the dragged tab still in the strip", () => {
    const next = dropThreadTab(one(["a", "b", "c"]), "a", { groupId: "main", index: 2 }, ids());
    expect(next?.groups[0]?.tabs).toEqual(["b", "a", "c"]);
  });

  it("collapses the group whose last tab moves into another group's center", () => {
    const next = dropThreadTab(sideBySide(), "c", { groupId: "main", zone: "center" }, ids());
    expect(next).toEqual({ ...one(["a", "b", "c"], "c") });
  });

  it("moves a tab between groups and hands its old group the tab to the right", () => {
    const next = dropThreadTab(sideBySide(), "a", { groupId: "g2", index: 0 }, ids());
    expect(next?.groups).toEqual([
      { id: "main", tabs: ["b"], active: "b" },
      { id: "g2", tabs: ["a", "c"], active: "a" },
    ]);
    expect(next?.focusedGroupId).toBe("g2");
  });
});

describe("closeThreadTab", () => {
  it("closes a tab beside the route without navigating", () => {
    expect(closeThreadTab(one(["a", "b"]), "b", "a")).toEqual({
      workspace: one(["a"]),
      navigateTo: undefined,
    });
    const absent = one(["a"]);
    expect(closeThreadTab(absent, "z", "a")).toEqual({ workspace: absent, navigateTo: undefined });
  });

  it("routes to the neighbouring tab when the routed tab closes", () => {
    expect(closeThreadTab(one(["a", "b", "c"], "b"), "b", "b")).toEqual({
      workspace: one(["a", "c"], "c"),
      navigateTo: "c",
    });
  });

  it("collapses an emptied group and routes into the group left", () => {
    const { workspace, navigateTo } = closeThreadTab(sideBySide("g2"), "c", "c");
    expect(workspace).toEqual(one(["a", "b"]));
    expect(navigateTo).toBe("a");
  });

  it("returns a group to the tab a pick opened over, not the one to its right", () => {
    const opened = reconcileRouteTab(sideBySide(), "d", "main");
    expect(opened.groups[0]).toEqual({
      id: "main",
      tabs: ["a", "d", "b"],
      active: "d",
      returnTo: { tab: "d", to: "a" },
    });
    const closed = closeThreadTab(opened, "d", "d");
    expect(closed.navigateTo).toBe("a");
    expect(closed.workspace?.groups[0]).toEqual({ id: "main", tabs: ["a", "b"], active: "a" });
    // The tab it would return to closed first: the usual neighbour takes over.
    const orphaned = closeThreadTab(opened, "a", "d").workspace!;
    expect(orphaned.groups[0]).toEqual({ id: "main", tabs: ["d", "b"], active: "d" });
    expect(closeThreadTab(orphaned, "d", "d").navigateTo).toBe("b");
    // Another tab closing keeps it.
    expect(closeThreadTab(opened, "b", "d").workspace?.groups[0]?.returnTo).toEqual({
      tab: "d",
      to: "a",
    });
  });

  it("leaves nothing to route to after the last tab", () => {
    expect(closeThreadTab(one(["a"]), "a", "a")).toEqual({ workspace: null, navigateTo: null });
  });
});

describe("group layout", () => {
  it("focuses, resizes and merges groups", () => {
    const workspace = sideBySide();
    expect(focusThreadTabGroup(workspace, "main")).toBe(workspace);
    expect(focusThreadTabGroup(workspace, "g2").focusedGroupId).toBe("g2");
    const resized = setThreadSplitRatio(workspace, "s1", 2);
    expect(resized.layout).toMatchObject({ ratio: 0.85 });
    expect(mergeThreadTabGroups(sideBySide("g2"))).toEqual({
      groups: [{ id: "g2", tabs: ["a", "b", "c"], active: "c" }],
      layout: leaf("g2"),
      focusedGroupId: "g2",
    });
    expect(mergeThreadTabGroups(one(["a"]))).toEqual(one(["a"]));
  });

  it("lays groups and dividers out from the tree", () => {
    const workspace = dropThreadTab(
      setThreadSplitRatio(sideBySide(), "s1", 0.25),
      "b",
      { groupId: "main", zone: "down" },
      ids(),
    )!;
    const { groups, dividers } = layoutGeometry(workspace.layout);
    expect(groups.get("main")).toEqual({ left: 0, top: 0, width: 0.25, height: 0.5 });
    expect(groups.get("n1")).toEqual({ left: 0, top: 0.5, width: 0.25, height: 0.5 });
    expect(groups.get("g2")).toEqual({ left: 0.25, top: 0, width: 0.75, height: 1 });
    expect(dividers.map((divider) => divider.split.id)).toEqual(["s1", "n2"]);
  });
});

describe("drop geometry", () => {
  const rect = { left: 0, top: 0, width: 300, height: 300 };
  it.each([
    [150, 150, "center"],
    [10, 150, "left"],
    [290, 150, "right"],
    [150, 10, "up"],
    [150, 290, "down"],
    [10, 10, "left"],
  ] as const)("(%s, %s) is %s", (x, y, zone) => {
    expect(resolveTabDropZone(rect, { x, y })).toBe(zone);
  });

  it.each([
    [5, 0],
    [60, 1],
    [500, 3],
  ])("x=%s inserts at %s", (x, index) => {
    const tabs = [0, 100, 200].map((left) => ({ left, width: 100 }));
    expect(resolveTabInsertIndex(tabs, x)).toBe(index);
  });
});

describe("parsePersistedWorkspace", () => {
  it("keeps a valid workspace and drops what it cannot use", () => {
    expect(parsePersistedWorkspace(sideBySide())).toEqual(sideBySide());
    expect(parsePersistedWorkspace("nope")).toBeNull();
    expect(parsePersistedWorkspace({ groups: [], layout: leaf("main") })).toBeNull();
    expect(
      parsePersistedWorkspace({
        groups: [
          { id: "main", tabs: ["a", "a", 3], active: "zz" },
          { id: "g2", tabs: ["a"], active: "a" },
          { id: "orphan", tabs: ["o"], active: "o" },
        ],
        layout: {
          type: "split",
          id: "s1",
          direction: "sideways",
          ratio: "x",
          first: leaf("main"),
          second: leaf("g2"),
          extra: true,
        },
        focusedGroupId: "missing",
      }),
    ).toEqual(one(["a"]));
    const withHistory = {
      ...sideBySide("g2"),
      groups: [
        { id: "main", tabs: ["a", "b"], active: "b", returnTo: { tab: "b", to: "a" } },
        { id: "g2", tabs: ["c"], active: "c", returnTo: { tab: "c", to: "gone" } },
      ],
      recentGroupIds: ["g2", 7, "closed", "main"],
    };
    expect(parsePersistedWorkspace(withHistory)).toEqual({
      ...sideBySide("g2"),
      groups: [
        { id: "main", tabs: ["a", "b"], active: "b", returnTo: { tab: "b", to: "a" } },
        { id: "g2", tabs: ["c"], active: "c" },
      ],
      recentGroupIds: ["g2", "main"],
    });
  });
});

describe("threadTabRow", () => {
  const ref = (id: string) => scopeThreadRef("env" as EnvironmentId, ThreadId.make(id));
  const A = ref("a");
  const B = ref("b");
  const key = (id: string) => scopedThreadKey(ref(id));
  const panels = () => useRightPanelStore.getState();
  /** `*` marks the active tab; a file shows as `thread/path`. */
  const show = (workspace: ThreadTabWorkspace | null) =>
    workspace === null
      ? []
      : threadTabRow(workspace.groups[0]!, panels().byThreadKey).map(
          (entry) =>
            `${entry.active ? "*" : ""}${entry.threadKey.split(":")[1]}${
              entry.kind === "file" ? `/${entry.surface.relativePath}` : ""
            }`,
        );
  const scenario = () => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    let workspace: ThreadTabWorkspace | null = reconcileRouteTab(undefined, key("a"));
    return {
      route: (id: string) => {
        workspace = reconcileRouteTab(workspace ?? undefined, key(id));
      },
      close: (id: string, routeId: string) => {
        workspace = workspace && closeThreadTab(workspace, key(id), key(routeId)).workspace;
      },
      drop: (id: string, index: number) => {
        workspace =
          (workspace && dropThreadTab(workspace, key(id), { groupId: "main", index }, ids())) ??
          workspace;
      },
      row: () => show(workspace),
    };
  };
  type Scenario = ReturnType<typeof scenario>;

  it.each<[string, (t: Scenario) => void, string[]]>([
    ["opens a thread as a tab after the active one", (t) => t.route("b"), ["a", "*b"]],
    [
      "opens a file beside the thread it came from, in opening order",
      (t) => {
        t.route("b");
        t.route("a");
        panels().openFile(A, "src/x.ts");
        panels().openFile(A, "src/y.ts");
      },
      ["a", "a/src/x.ts", "*a/src/y.ts", "b"],
    ],
    [
      "keeps another thread's files beside that thread, inactive",
      (t) => {
        panels().openFile(B, "b.ts");
        t.route("b");
        t.route("a");
      },
      ["*a", "b", "b/b.ts"],
    ],
    [
      "lands on the chat tab from the sidebar, even over a file of the same thread",
      (t) => {
        panels().openFile(A, "x.ts");
        panels().showChat(A);
        t.route("a");
      },
      ["*a", "a/x.ts"],
    ],
    [
      "picks a file tab of another thread by activating it and routing there",
      (t) => {
        panels().openFile(B, "b.ts");
        panels().showChat(B);
        t.route("b");
        t.route("a");
        panels().activateSurface(B, "file:b.ts");
        t.route("b");
      },
      ["a", "b", "*b/b.ts"],
    ],
    [
      "closes a file tab and hands focus to its neighbour",
      () => {
        panels().openFile(A, "x.ts");
        panels().openFile(A, "y.ts");
        panels().closeSurface(A, "file:y.ts");
      },
      ["a", "*a/x.ts"],
    ],
    [
      "takes a thread's files out of the row with it, and back as they were when it reopens",
      (t) => {
        panels().openFile(B, "b.ts");
        t.route("b");
        t.close("b", "a");
        expect(t.row()).toEqual(["*a"]);
        t.route("b");
      },
      ["a", "b", "*b/b.ts"],
    ],
    [
      "reorders a thread with its files as one block",
      (t) => {
        t.route("b");
        panels().openFile(A, "x.ts");
        t.drop("b", 0);
      },
      ["*b", "a", "a/x.ts"],
    ],
  ])("%s", (_name, steps, expected) => {
    const t = scenario();
    steps(t);
    expect(t.row()).toEqual(expected);
  });

  it("derives the row from layouts and panels saved before the unified strip", () => {
    const workspace = parsePersistedWorkspace({
      groups: [{ id: "main", tabs: [key("a"), key("b")], active: key("b") }],
      layout: leaf("main"),
      focusedGroupId: "main",
    });
    const file = (path: string) => ({
      id: `file:${path}`,
      kind: "file",
      relativePath: path,
      revealLine: null,
      revealRequestId: 1,
    });
    const { byThreadKey } = migratePersistedRightPanelState({
      byThreadKey: {
        [key("b")]: {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff" }, file("one.ts"), file("two.ts")],
          activeMainId: "file:two.ts",
        },
      },
    });
    useRightPanelStore.setState({ byThreadKey });
    expect(show(workspace)).toEqual(["a", "b", "b/one.ts", "*b/two.ts"]);
  });
});
