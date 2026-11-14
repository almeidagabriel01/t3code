import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthSettingsWriteScope,
  type AssistantId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { readEnvironmentScope } from "../../state/session";
import { SettingsModelPicker } from "./components/SettingsModelPicker";
import { SettingsScreen } from "./components/SettingsScreen";
import { connectedSettingsTargets } from "./settings-environment-filter";
import {
  planMobileProjectAssistantModel,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export type ProjectModelPickerParams = {
  /** The project's checkouts the model is saved to; models are listed from the first. */
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
  /** Picks this assistant's model in the project instead of the project's own. */
  readonly assistantId?: AssistantId;
};

/** Picks a project's model for new threads, or one assistant's model in it; each choice saves. */
export function ProjectModelPickerRouteScreen({
  route,
}: StaticScreenProps<ProjectModelPickerParams>) {
  const { members, assistantId } = route.params;
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const writeSettings = useSettingsWriter();
  const targets = resolveMobileSettingsTargets(
    connectedSettingsTargets(environments),
    members.map((member) => ({ environmentId: member.environmentId, id: member.projectId })),
  );
  const first = targets[0];
  if (first === undefined || first.projectId === null) {
    return (
      <SettingsScreen title="Project model">
        <Text className="p-5 text-base text-foreground-muted">
          Connect this project's environment to choose its model.
        </Text>
      </SettingsScreen>
    );
  }
  const projectDefault = first.settings.defaultModelSelection;
  // Without an exception the assistant runs on the project's own model; failing that, on a group's
  // or its own default this screen cannot see, so nothing is marked.
  const selected =
    assistantId === undefined
      ? projectDefault
      : (first.environment.serverConfig.settings.projectSettingsOverrides[first.projectId]
          ?.assistantModelSelections?.[assistantId] ??
        (first.sources.defaultModelSelection === "environment" ? null : projectDefault));
  return (
    <SettingsModelPicker
      title={assistantId === undefined ? "Project model" : "Assistant model"}
      environmentId={first.environment.environmentId}
      projectId={first.projectId}
      selected={selected}
      onPick={(selection) => {
        if (
          !targets.every((target) =>
            readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
          )
        )
          return;
        void writeSettings(
          targets,
          assistantId === undefined
            ? planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: selection })
            : planMobileProjectAssistantModel(
                targets,
                first.environment.environmentId,
                assistantId,
                selection,
              ),
        );
      }}
      onClose={() => navigation.goBack()}
    />
  );
}
