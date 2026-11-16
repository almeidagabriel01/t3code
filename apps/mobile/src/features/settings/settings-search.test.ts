import { describe, expect, it } from "vite-plus/test";

import { filterSettingsSections, SETTINGS_PAGE_LABELS } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "T3 Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
      { id: "SettingsVoice", label: "Voice" },
    ],
  },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control" },
      { id: "SettingsEnvironmentMaintenance", label: "Maintenance" },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    // Descriptions count too: Maintenance says new models "may not appear", Voice names the keyboard.
    {
      query: "appear",
      expected: [
        ["Interface", ["Appearance"]],
        ["Server settings", ["Maintenance"]],
      ],
    },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard", "Voice"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "microphone", expected: [["Interface", ["Voice"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control", "Maintenance"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    ...[
      "CPU limit",
      "Keep memory free",
      "Jobs at once on Linux",
      "Over the limit for",
      "linux pc",
      "linux cpu limit",
      "mac memory",
      "cpu limit this mac",
    ].map((query) => ({ query, expected: [["Server settings", ["Maintenance"]]] })),
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  const everyPage = [
    { rows: Object.keys(SETTINGS_PAGE_LABELS).map((id) => ({ id, label: "Page" })) },
  ];
  it.each(
    Object.entries(SETTINGS_PAGE_LABELS).flatMap(([page, labels]) =>
      labels.map((label) => ({ page, label })),
    ),
  )("finds $page by the text it draws: $label", ({ page, label }) => {
    const found = filterSettingsSections(everyPage, label).flatMap((section) => section.rows);
    expect(found.map((row) => row.id)).toContain(page);
  });

  // Names users type for a page that it does not draw: server-provided rows and what it does.
  it.each([
    { query: "login", page: "account" },
    { query: "tailscale", page: "SettingsEnvironments" },
    { query: "push", page: "SettingsNotifications" },
    { query: "colors", page: "SettingsAppearance" },
    { query: "sidebar", page: "SettingsNavigation" },
    { query: "on-device", page: "SettingsVoice" },
    { query: "cron", page: "SettingsScheduledTasks" },
    { query: "overview", page: "SettingsProjectOverview" },
    { query: "group projects", page: "SettingsOrganization" },
    { query: "thread behavior", page: "SettingsThreads" },
    { query: "follow-ups", page: "SettingsFollowUp" },
    { query: "cards", page: "SettingsKanban" },
    { query: "tools", page: "SettingsAgentTools" },
    { query: "jarvis", page: "SettingsAssistants" },
    { query: "oauth", page: "SettingsIntegrations" },
    { query: "take over", page: "SettingsDevices" },
    { query: "privacy", page: "SettingsMacPermissions" },
    { query: "wayland", page: "SettingsComputerUse" },
    { query: "markdown", page: "SettingsNotes" },
    { query: "unarchive", page: "SettingsArchive" },
    { query: "codex", page: "SettingsProviderAccounts" },
    { query: "background priority", page: "SettingsEnvironmentMaintenance" },
    { query: "terms", page: "SettingsAbout" },
  ])("finds $page by a name users type: $query", ({ query, page }) => {
    const found = filterSettingsSections(everyPage, query).flatMap((section) => section.rows);
    expect(found.map((row) => row.id)).toContain(page);
  });

  it.each(["linear", "google"])(
    "finds Integrations by a live name only when it has one: %s",
    (query) => {
      const ids = (labels?: Readonly<Record<string, readonly string[]>>) =>
        filterSettingsSections(everyPage, query, labels)
          .flatMap((section) => section.rows)
          .map((row) => row.id);
      expect(ids()).not.toContain("SettingsIntegrations");
      expect(ids({ SettingsIntegrations: ["Google Calendar", "Linear"] })).toContain(
        "SettingsIntegrations",
      );
    },
  );

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });
});
