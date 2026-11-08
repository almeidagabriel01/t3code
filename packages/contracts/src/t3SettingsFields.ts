import { T3GlobalSkillSettingsFields, T3GlobalSkillSettingsPatchFields } from "./globalSkills.ts";
import { T3McpServerSettingsFields, T3McpServerSettingsPatchFields } from "./mcpServers.ts";

export const T3SettingsFields = {
  ...T3McpServerSettingsFields,
  ...T3GlobalSkillSettingsFields,
};
export const T3SettingsPatchFields = {
  ...T3McpServerSettingsPatchFields,
  ...T3GlobalSkillSettingsPatchFields,
};
