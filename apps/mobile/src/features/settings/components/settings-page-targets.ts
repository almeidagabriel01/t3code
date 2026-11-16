/** Settings pages a Settings row opens. */
export const SETTINGS_PAGE_TARGETS = [
  "SettingsEnvironments",
  "SettingsNotifications",
  "SettingsThreads",
  "SettingsAbout",
  "SettingsArchive",
  "SettingsAppearance",
  "SettingsNavigation",
  "SettingsOrganization",
  "SettingsProjectOverview",
  "SettingsEnvironmentSourceControl",
  "SettingsWorktrees",
  "SettingsLabs",
  "SettingsEnvironmentMaintenance",
  "SettingsResourceManager",
  "SettingsProviderAccounts",
  "SettingsUsageAlerts",
  "SettingsKeyboard",
  "SettingsVoice",
  "SettingsFollowUp",
  "SettingsScheduledTasks",
  "SettingsProjectGrouping",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsUsage",
  "SettingsKanban",
  "SettingsNotes",
  "SettingsMemory",
  "SettingsAgentTools",
  "SettingsAssistants",
  "SettingsIntegrations",
  "SettingsImessage",
  "SettingsTelegram",
  "SettingsMacPermissions",
  "SettingsDevices",
  "SettingsComputerUse",
] as const;

export type SettingsPageTarget = (typeof SETTINGS_PAGE_TARGETS)[number];

export type SettingsLegalDocumentTarget = "SettingsLegal";

// Page ids both clients share whose mobile screen is named differently.
const SETTINGS_LINK_PAGE_ALIASES: Readonly<Record<string, SettingsPageTarget>> = {
  "source-control": "SettingsEnvironmentSourceControl",
  maintenance: "SettingsEnvironmentMaintenance",
};

/** The screen a `t3-settings://` link's page opens; null opens Settings itself. */
export function settingsLinkPageTarget(page: string | null): SettingsPageTarget | null {
  if (page === null) return null;
  const alias = SETTINGS_LINK_PAGE_ALIASES[page];
  if (alias) return alias;
  const name = `Settings${page.replace(/(?:^|-)([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())}`;
  return SETTINGS_PAGE_TARGETS.find((target) => target === name) ?? null;
}
