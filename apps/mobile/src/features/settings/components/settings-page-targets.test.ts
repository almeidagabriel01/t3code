import { describe, expect, it } from "vite-plus/test";

import { settingsLinkPageTarget } from "./settings-page-targets";

describe("settingsLinkPageTarget", () => {
  it.each([
    ["integrations", "SettingsIntegrations"],
    ["assistants", "SettingsAssistants"],
    ["memory", "SettingsMemory"],
    ["mac-permissions", "SettingsMacPermissions"],
    ["source-control", "SettingsEnvironmentSourceControl"],
    ["maintenance", "SettingsEnvironmentMaintenance"],
    ["not-a-page", null],
    ["legal", null],
    [null, null],
  ])("%s opens %s", (page, target) => {
    expect(settingsLinkPageTarget(page)).toBe(target);
  });
});
