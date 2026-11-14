import { useNavigation } from "@react-navigation/native";
import {
  AuthSettingsWriteScope,
  type AssistantId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";

import { buildModelOptions } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { modelDisplayName } from "../settings/components/SettingsModelPicker";
import { connectedSettingsTargets } from "../settings/settings-environment-filter";
import {
  planMobileProjectAssistantModel,
  resolveMobileSettingsTargets,
} from "../settings/settings-scoped-server";
import { useSettingsWriter } from "../settings/useSettingsWriter";

export type GroupProjectModel = NonNullable<ReturnType<typeof useGroupProjectModel>>;

/**
 * The project's model for new work, and each member's own model there, read from and saved to
 * the same project settings the Settings screens use. Null without a project or its environment.
 */
export function useGroupProjectModel(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  /** The group's default, which the project's requests run on when it has none of its own. */
  teamDefault: ModelSelection | null,
) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const config = useEnvironmentServerConfig(environmentId);
  const writeSettings = useSettingsWriter();
  const connected = connectedSettingsTargets(environments).filter(
    (environment) => environment.environmentId === environmentId,
  );
  const writable = useEnvironmentsWithScope(connected, AuthSettingsWriteScope);
  if (projectId === null) return null;
  const project = projects.find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  const targets = resolveMobileSettingsTargets(connected, [
    {
      environmentId,
      id: projectId,
      ...(project === undefined ? {} : { workspaceRoot: project.workspaceRoot }),
    },
  ]);
  const target = targets[0];
  if (target === undefined) return null;
  const nameOf = (selection: ModelSelection) =>
    modelDisplayName(buildModelOptions(config, selection, undefined, projectId), selection);
  const selection = target.settings.defaultModelSelection;
  const members = [{ environmentId, projectId }];
  const inherited = target.sources.defaultModelSelection === "environment";
  return {
    label: !inherited
      ? selection === null
        ? "Automatic"
        : nameOf(selection)
      : teamDefault === null
        ? "Members' models"
        : nameOf(teamDefault),
    canWrite: writable.has(environmentId),
    /** Members whose new work here runs on their own model, by assistant id. */
    exceptions: (target.environment.serverConfig.settings.projectSettingsOverrides[projectId]
      ?.assistantModelSelections ?? {}) as Readonly<Record<string, ModelSelection>>,
    nameOf,
    openProjectPicker: () => navigation.navigate("SettingsProjectModel", { members }),
    openMemberPicker: (assistantId: AssistantId) =>
      navigation.navigate("SettingsProjectModel", { members, assistantId }),
    removeException: (assistantId: AssistantId) =>
      void writeSettings(
        targets,
        planMobileProjectAssistantModel(targets, environmentId, assistantId, null),
      ),
  };
}
