import { useAtom } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  type AssistantGroupTabKey,
  assistantGroupComposerModel,
  assistantGroupTabPick,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  AuthSettingsWriteScope,
  type AssistantId,
  type AssistantTeamId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { projectModelLayer } from "@t3tools/shared/modelSelectionPrecedence";

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
import { groupMessageModelAtom } from "./GroupMessageModelPickerRouteScreen";

export type GroupProjectModel = NonNullable<ReturnType<typeof useGroupProjectModel>>;

/**
 * The model the group's next message runs on: its own pick for that message, else the project's
 * model for new work. The project's model and each member's own model there are read from and
 * saved to the same project settings the Settings screens use; the message's pick saves nothing.
 * Null without a project or its environment.
 */
export function useGroupProjectModel(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  /** The group's default where it holds in this project (`teamModelLayer`). */
  teamDefault: ModelSelection | null,
  at: { readonly teamId: AssistantTeamId; readonly tab: AssistantGroupTabKey | null },
) {
  const navigation = useNavigation();
  const [pick, setPick] = useAtom(groupMessageModelAtom(at.teamId));
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
  const optionsFor = (selection: ModelSelection) =>
    buildModelOptions(config, selection, undefined, projectId);
  const nameOf = (selection: ModelSelection) => modelDisplayName(optionsFor(selection), selection);
  // The composer chip's name ("Sonnet 5.5"), as the web composer shows it.
  const shortNameOf = (selection: ModelSelection) =>
    optionsFor(selection).find(
      (option) =>
        option.selection.instanceId === selection.instanceId &&
        option.selection.model === selection.model,
    )?.shortName ?? nameOf(selection);
  const selection = target.settings.defaultModelSelection;
  const members = [{ environmentId, projectId }];
  const settings = target.environment.serverConfig.settings;
  const layers = {
    project: projectModelLayer(target.sources.defaultModelSelection, selection),
    team: teamDefault ?? undefined,
  };
  // With neither, `global` means each member runs on its own model.
  const fallback = layers.project ?? layers.team ?? selection;
  const isUsable = (value: ModelSelection) =>
    resolveProjectProviderInstanceEnabled(settings, projectId, value.instanceId);
  const shown = (messagePick: typeof pick) => {
    // With no default at all, a pick the project cannot use leaves each member on its own.
    const global = fallback ?? assistantGroupTabPick(messagePick, at.tab)?.value;
    return global === undefined
      ? null
      : assistantGroupComposerModel({
          pick: messagePick,
          tab: at.tab,
          defaults: { ...layers, global },
          isUsable,
          available: { settings, projectId, providers: config?.providers ?? [] },
        });
  };
  const labelOf = (resolved: ReturnType<typeof shown>, name = nameOf) =>
    resolved === null || resolved.layer === "global" ? "Members' models" : name(resolved.selection);
  const current = shown(pick);
  return {
    label: labelOf(current),
    shortLabel: labelOf(current, shortNameOf),
    /** The chip shows the message's own pick, not a default. */
    forMessage: current?.forMessage ?? false,
    /** What the next send carries: the pick, never a default. */
    messageModel: assistantGroupTabPick(pick, at.tab)?.value,
    /** What the chip goes back to without the pick. */
    defaultLabel: labelOf(shown(null)),
    openMessagePicker: () =>
      navigation.navigate("GroupMessageModel", {
        environmentId,
        projectId,
        teamId: at.teamId,
        tab: at.tab,
        selected: current?.selection ?? null,
      }),
    clearMessageModel: () => setPick(null),
    canWrite: writable.has(environmentId),
    /** Members whose new work here runs on their own model, by assistant id. */
    exceptions: (target.environment.serverConfig.settings.projectSettingsOverrides[projectId]
      ?.assistantModelSelections ?? {}) as Readonly<Record<string, ModelSelection>>,
    nameOf,
    openProjectPicker: () =>
      navigation.navigate("SettingsProjectModel", {
        members,
        // Without the project's model, the group's default applies where it holds.
        clearLabel:
          teamDefault !== null && isUsable(teamDefault) ? "Group default" : "Members' models",
      }),
    openMemberPicker: (assistantId: AssistantId) =>
      navigation.navigate("SettingsProjectModel", { members, assistantId }),
    removeException: (assistantId: AssistantId) =>
      void writeSettings(
        targets,
        planMobileProjectAssistantModel(targets, environmentId, assistantId, null),
      ),
  };
}
