import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RAIL_PREFERENCES,
  moveRailItem,
  orderRailItems,
  railPreferencesForHydration,
  RAIL_ITEM_IDS,
  resolveActiveDestination,
  resolveRailItems,
  setRailItemShown,
  type RailContext,
  type RailPreferences,
} from "./destinationRail.logic";

describe("resolveActiveDestination", () => {
  it.each([
    ["/", "home"],
    ["/env-1/thread-1", "home"],
    ["/draft/draft-1", "home"],
    ["/new", "home"],
    ["/activity", "activity"],
    ["/kanban", "board"],
    ["/usage", "usage"],
    ["/pull-requests", "pullRequests"],
    ["/settings/scheduled-tasks", "scheduled"],
    ["/settings/archived", "archived"],
    ["/settings", "settings"],
    ["/settings/appearance", "settings"],
    ["/settings/archived-extra", "settings"],
    ["/projects/t3code", "settings"],
  ] as const)("maps %s to %s", (pathname, expected) => {
    expect(resolveActiveDestination(pathname)).toBe(expected);
  });
});

const everything: RailContext = {
  boardAvailable: true,
  pullRequestsSupported: true,
  canAddProvider: true,
  primaryProviderReady: true,
};

const shownIds = (preferences: RailPreferences, context: RailContext) =>
  resolveRailItems(preferences, context)
    .filter((item) => item.shown)
    .map((item) => item.id);

describe("resolveRailItems", () => {
  it("shows the everyday destinations with a working provider", () => {
    expect(shownIds(DEFAULT_RAIL_PREFERENCES, everything)).toEqual([
      "activity",
      "board",
      "pullRequests",
      "usage",
      "scheduled",
      "archived",
    ]);
  });

  it("drops the board without a kanban environment", () => {
    expect(
      shownIds(DEFAULT_RAIL_PREFERENCES, { ...everything, boardAvailable: false }),
    ).not.toContain("board");
  });

  it("offers Add provider only once providers have loaded and none is ready", () => {
    const shownFor = (primaryProviderReady: boolean | null) =>
      shownIds(DEFAULT_RAIL_PREFERENCES, { ...everything, primaryProviderReady });
    expect(shownFor(false)).toContain("addProvider");
    expect(shownFor(null)).not.toContain("addProvider");
    expect(shownFor(true)).not.toContain("addProvider");
  });

  it("keeps an item the person turned on when its context default turns off", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "addProvider", true);
    expect(shownIds(preferences, { ...everything, primaryProviderReady: false })).toContain(
      "addProvider",
    );
    expect(shownIds(preferences, everything)).toContain("addProvider");
  });

  it("keeps an item the person hid", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "usage", false);
    expect(shownIds(preferences, everything)).not.toContain("usage");
  });

  it("does not show an unavailable item but keeps the person's choice for later", () => {
    const preferences = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "pullRequests", true);
    const unsupported = resolveRailItems(preferences, {
      ...everything,
      pullRequestsSupported: false,
    }).find((item) => item.id === "pullRequests");
    expect(unsupported).toMatchObject({ shown: false, available: false, choice: "shown" });
    expect(shownIds(preferences, everything)).toContain("pullRequests");
  });

  it("switching a choice replaces the earlier one", () => {
    const hidden = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "archived", false);
    const shown = setRailItemShown(hidden, "archived", true);
    expect(shown.hidden).not.toContain("archived");
    expect(shown.shown).toEqual(["archived"]);
  });

  it("ignores ids this version does not know", () => {
    const preferences = { order: ["notes", "usage"], shown: ["jarvis"], hidden: ["memory"] };
    expect(resolveRailItems(preferences, everything).map((item) => item.id)).toEqual(
      orderRailItems(["usage"]),
    );
  });
});

describe("rail order", () => {
  it("drops unknown and repeated ids and appends missing items in default order", () => {
    expect(orderRailItems(["archived", "future-item", "archived", "usage"])).toEqual([
      "archived",
      "usage",
      ...RAIL_ITEM_IDS.filter((id) => id !== "archived" && id !== "usage"),
    ]);
  });

  it("moves an item one step and keeps other versions' ids", () => {
    const moved = moveRailItem(
      { ...DEFAULT_RAIL_PREFERENCES, order: ["future-item"] },
      "usage",
      -1,
    );
    const order = orderRailItems(moved.order);
    expect(order.indexOf("usage")).toBe(RAIL_ITEM_IDS.indexOf("pullRequests"));
    expect(moved.order).toContain("future-item");
  });

  it.each([
    ["activity", -1],
    ["addProvider", 1],
  ] as const)("leaves %s in place at the edge", (id, delta) => {
    expect(moveRailItem(DEFAULT_RAIL_PREFERENCES, id, delta)).toBe(DEFAULT_RAIL_PREFERENCES);
  });

  it("composes consecutive moves and toggles", () => {
    let preferences = moveRailItem(DEFAULT_RAIL_PREFERENCES, "archived", -1);
    preferences = moveRailItem(preferences, "archived", -1);
    preferences = setRailItemShown(preferences, "archived", false);
    const items = resolveRailItems(preferences, everything).map((item) => item.id);
    expect(items.indexOf("archived")).toBe(RAIL_ITEM_IDS.indexOf("archived") - 2);
    expect(shownIds(preferences, everything)).not.toContain("archived");
  });
});

describe("railPreferencesForHydration", () => {
  const saved = setRailItemShown(DEFAULT_RAIL_PREFERENCES, "usage", false);

  it.each([
    ["pending", null],
    ["retrying", null],
    ["ready", saved],
    ["failed", DEFAULT_RAIL_PREFERENCES],
  ] as const)("uses %s settings as %o", (status, expected) => {
    expect(railPreferencesForHydration(status, saved)).toBe(expected);
  });
});
