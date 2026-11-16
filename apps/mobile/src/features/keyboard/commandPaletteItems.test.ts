import { describe, expect, it } from "vite-plus/test";

import { vi } from "vite-plus/test";

import {
  assistantInfoItems,
  autonomyPauseItems,
  filterCommandPaletteItems,
  settingsPageItem,
  type CommandPaletteItem,
} from "./commandPaletteItems";

const NOW = Date.UTC(2026, 9, 23);

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return {
    key,
    title,
    kind,
    searchTerms,
    ...(kind === "thread" ? { threadSearch: { title, activityAt: NOW } } : {}),
    run: () => {},
  };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread"),
  item("mac:one", "Mobile app layout", "thread"),
];
const keys = (results: ReadonlyArray<{ readonly key: string }>) =>
  results.map((entry) => entry.key);

describe("filterCommandPaletteItems", () => {
  it("ranks like the web palette, whole words first, with every token required", () => {
    // A thread active today outranks a project that matches as well, but not
    // one whose whole name was typed.
    expect(keys(filterCommandPaletteItems(items, "mobile", [], NOW))).toEqual([
      "mac:one",
      "project",
    ]);
    expect(keys(filterCommandPaletteItems(items, " MOBILE app ", [], NOW))).toEqual([
      "project",
      "mac:one",
    ]);
    expect(keys(filterCommandPaletteItems(items, "keyboard short", [], NOW))).toEqual(["siva:one"]);
  });

  it("lists message matches after the other results, once, except in actions-only mode", () => {
    const results = filterCommandPaletteItems(items, "layout", ["siva:one", "mac:one"], NOW);
    expect(results.map((entry) => [entry.key, entry.fromMessages ?? false])).toEqual([
      ["mac:one", false],
      ["siva:one", true],
    ]);
    expect(filterCommandPaletteItems(items, "> layout", ["siva:one"], NOW)).toEqual([]);
  });
});

describe("autonomyPauseItems", () => {
  it("offers pause or resume by the current state, and nothing without a server", () => {
    expect(autonomyPauseItems(null)).toEqual([]);
    const toggle = vi.fn();
    const [pause] = autonomyPauseItems({ enabled: true, toggle });
    expect(pause?.title).toBe("Pause assistant notifications");
    expect(
      keys(
        filterCommandPaletteItems(autonomyPauseItems({ enabled: true, toggle }), "mute", [], NOW),
      ),
    ).toEqual(["toggle-assistant-notifications"]);
    pause?.run();
    expect(toggle).toHaveBeenCalledOnce();
    expect(autonomyPauseItems({ enabled: false, toggle })[0]?.title).toBe(
      "Turn on assistant notifications",
    );
  });
});

describe("assistantInfoItems", () => {
  const ada = { environmentId: "hub", assistant: { id: "ada", name: "Ada", threadId: "chat-ada" } };
  const crew = { environmentId: "hub", team: { id: "crew", name: "Crew" } };
  it.each([
    { pathname: "/threads/hub/chat-ada", expected: ["Assistant info", "ada"] },
    { pathname: "/threads/other/chat-ada", expected: null },
    { pathname: "/threads/hub/plain", expected: null },
    { pathname: "/assistant-groups/hub/crew", expected: ["Group info", "crew"] },
    { pathname: "/assistant-groups/hub/gone", expected: null },
    { pathname: "/settings", expected: null },
  ])("$pathname", ({ pathname, expected }) => {
    const opened: string[] = [];
    const items = assistantInfoItems({
      pathname,
      assistants: [ada],
      teams: [crew],
      openAssistant: (entry) => opened.push(entry.assistant.id),
      openGroup: (entry) => opened.push(entry.team.id),
    });
    if (expected === null) {
      expect(items).toEqual([]);
      return;
    }
    expect(items.map((entry) => entry.title)).toEqual([expected[0]]);
    items[0]!.run();
    expect(opened).toEqual([expected[1]]);
  });
});

describe("settingsPageItem", () => {
  const pages = (
    [
      ["SettingsEnvironments", "Manage environments"],
      ["SettingsScheduledTasks", "Scheduled tasks"],
      ["SettingsResourceManager", "Resource Manager"],
      ["SettingsMacPermissions", "Mac permissions"],
      ["SettingsArchive", "Archived threads"],
      ["SettingsAssistants", "Assistants"],
      ["SettingsIntegrations", "Integrations"],
      ["SettingsUsage", "Usage"],
    ] as const
  ).map(([target, title]) => settingsPageItem(target, title, target, () => {}));

  it.each([
    { query: "tailscale", page: "SettingsEnvironments" },
    { query: "cron", page: "SettingsScheduledTasks" },
    { query: "processes", page: "SettingsResourceManager" },
    { query: "privacy", page: "SettingsMacPermissions" },
    { query: "unarchive", page: "SettingsArchive" },
    { query: "jarvis", page: "SettingsAssistants" },
    { query: "team", page: "SettingsAssistants" },
    { query: "oauth", page: "SettingsIntegrations" },
    { query: "limits", page: "SettingsUsage" },
    { query: "processed tokens", page: "SettingsUsage" },
    { query: "cache savings", page: "SettingsUsage" },
    { query: "by model", page: "SettingsUsage" },
  ])("finds $page by the text it draws: $query", ({ query, page }) => {
    expect(keys(filterCommandPaletteItems(pages, query, []))).toContain(page);
  });
});
