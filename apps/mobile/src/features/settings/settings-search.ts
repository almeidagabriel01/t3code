import { foldSearchQuery, rankSearchItems, scoreSearchTerms } from "@t3tools/shared/paletteSearch";

import { ARCHIVE_PAGE_LABELS } from "../archive/archiveCopy";
import { ASSISTANTS_PAGE_LABELS } from "../assistants/settingsAssistantsCopy";
import { ENVIRONMENTS_PAGE_LABELS } from "../connection/environmentsCopy";
import { IMESSAGE_PAGE_LABELS } from "../imessage/imessageCopy";
import { INTEGRATIONS_PAGE_LABELS } from "../integrations/integrationsCopy";
import { KANBAN_PAGE_LABELS } from "../kanban/kanbanBoardCopy";
import { NOTES_PAGE_LABELS } from "../notes/notesCopy";
import { TELEGRAM_PAGE_LABELS } from "../telegram/telegramCopy";
import { ABOUT_PAGE_LABELS } from "./aboutCopy";
import { ACCOUNT_PAGE_LABELS } from "./accountCopy";
import { AGENT_TOOLS_PAGE_LABELS } from "./agentToolsCopy";
import { APPEARANCE_PAGE_LABELS } from "./appearance/appearanceCopy";
import { CHAT_PAGE_LABELS } from "./chatCopy";
import type { SettingsPageTarget } from "./components/settings-page-targets";
import { COMPUTER_USE_PAGE_LABELS } from "./computerUseCopy";
import { DEVICES_PAGE_LABELS } from "./devicesCopy";
import { KEYBOARD_PAGE_LABELS } from "./keyboardCopy";
import { MAC_PERMISSIONS_PAGE_LABELS } from "./macPermissionsCopy";
import { MEMORY_PAGE_LABELS } from "./memoryCopy";
import { NAVIGATION_PAGE_LABELS } from "./navigationCopy";
import { NOTIFICATIONS_PAGE_LABELS } from "./notificationsCopy";
import { GENERAL_PAGE_LABELS } from "./projectGroupingCopy";
import { PROJECTS_PAGE_LABELS } from "./projectOverviewCopy";
import { PROVIDERS_PAGE_LABELS } from "./providerAccountsCopy";
import { SCHEDULED_TASKS_PAGE_LABELS } from "./scheduledTasksCopy";
import {
  LABS_PAGE_LABELS,
  MAINTENANCE_SERVER_PAGE_LABELS,
  SOURCE_CONTROL_PAGE_LABELS,
  THREADS_PAGE_LABELS,
  WORKTREES_PAGE_LABELS,
} from "./serverSettingsCopy";
import { VOICE_PAGE_LABELS } from "./voiceCopy";

/** Pages a row of the Settings list opens without one of its own: their text joins the parent's. */
type SubPage =
  | "SettingsResourceManager"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

/** The text each Settings list row's page draws, so search finds a setting by its own name. */
export const SETTINGS_PAGE_LABELS: Record<
  Exclude<SettingsPageTarget, SubPage> | "account",
  readonly string[]
> = {
  account: ACCOUNT_PAGE_LABELS,
  SettingsEnvironments: ENVIRONMENTS_PAGE_LABELS,
  SettingsNotifications: NOTIFICATIONS_PAGE_LABELS,
  SettingsOrganization: GENERAL_PAGE_LABELS,
  SettingsAppearance: APPEARANCE_PAGE_LABELS,
  SettingsFollowUp: CHAT_PAGE_LABELS,
  SettingsNavigation: NAVIGATION_PAGE_LABELS,
  SettingsKeyboard: KEYBOARD_PAGE_LABELS,
  SettingsVoice: VOICE_PAGE_LABELS,
  SettingsProviderAccounts: PROVIDERS_PAGE_LABELS,
  SettingsThreads: THREADS_PAGE_LABELS,
  SettingsAgentTools: AGENT_TOOLS_PAGE_LABELS,
  SettingsAssistants: ASSISTANTS_PAGE_LABELS,
  SettingsIntegrations: INTEGRATIONS_PAGE_LABELS,
  SettingsImessage: IMESSAGE_PAGE_LABELS,
  SettingsTelegram: TELEGRAM_PAGE_LABELS,
  SettingsMacPermissions: MAC_PERMISSIONS_PAGE_LABELS,
  SettingsDevices: DEVICES_PAGE_LABELS,
  SettingsComputerUse: COMPUTER_USE_PAGE_LABELS,
  SettingsScheduledTasks: SCHEDULED_TASKS_PAGE_LABELS,
  SettingsKanban: KANBAN_PAGE_LABELS,
  SettingsNotes: NOTES_PAGE_LABELS,
  SettingsMemory: MEMORY_PAGE_LABELS,
  SettingsProjectOverview: PROJECTS_PAGE_LABELS,
  SettingsEnvironmentSourceControl: SOURCE_CONTROL_PAGE_LABELS,
  SettingsWorktrees: WORKTREES_PAGE_LABELS,
  SettingsEnvironmentMaintenance: MAINTENANCE_SERVER_PAGE_LABELS,
  SettingsLabs: LABS_PAGE_LABELS,
  SettingsAbout: ABOUT_PAGE_LABELS,
  SettingsArchive: ARCHIVE_PAGE_LABELS,
};

const termsById: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SETTINGS_PAGE_LABELS),
);

export interface SettingsSearchRow {
  readonly id: string;
  readonly label: string;
}

export interface SettingsSearchSection<Row extends SettingsSearchRow> {
  readonly title?: string;
  readonly rows: readonly Row[];
}

/**
 * Keeps the rows whose label, section, or page contents match `query`, in list order, and drops
 * sections left empty. Matching is the command palette's, so both searches agree.
 */
export function filterSettingsSections<
  Row extends SettingsSearchRow,
  Section extends SettingsSearchSection<Row>,
>(sections: readonly Section[], query: string): Section[] {
  const normalizedQuery = foldSearchQuery(query);
  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, section: section.title })),
  );
  const matched = normalizedQuery
    ? new Set(
        rankSearchItems(rows, ({ row, section }, options) =>
          scoreSearchTerms(
            normalizedQuery,
            [row.label, ...(section ? [section] : []), ...(termsById.get(row.id) ?? [])],
            options,
          ),
        ).map(({ item }) => item.row),
      )
    : null;
  return sections.flatMap((section) => {
    const kept = matched ? section.rows.filter((row) => matched.has(row)) : section.rows;
    return kept.length ? [{ ...section, rows: kept }] : [];
  });
}
