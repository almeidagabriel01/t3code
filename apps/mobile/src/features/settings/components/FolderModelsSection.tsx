import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  FolderModelDefault,
  ModelSelection,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { Menu } from "../../../components/ui/Menu";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { buildModelOptions } from "../../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const REMOVE_ACTIONS: MenuAction[] = [
  { id: "remove", title: "Remove", attributes: { destructive: true } },
];

/** Projects inside a folder start new threads with that folder's model. */
export function FolderModelsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly rules: ReadonlyArray<FolderModelDefault>;
  /** Editing needs one environment: the rules are per environment, and the picker saves to one. */
  readonly editable: boolean;
  readonly mixed: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const navigation = useNavigation();
  const config = useEnvironmentServerConfig(props.environmentId);
  const options = useMemo(() => buildModelOptions(config, null, undefined, null), [config]);
  const describe = (selection: ModelSelection) => {
    const option = options.find(
      (candidate) =>
        candidate.selection.instanceId === selection.instanceId &&
        candidate.selection.model === selection.model,
    );
    return [option?.label ?? selection.model, option?.providerLabel].filter(Boolean).join(" · ");
  };
  const footer = props.mixed
    ? "These environments differ. Select one to edit its folder models."
    : props.editable
      ? "Projects inside a folder start new threads with its model; a project's own setting still wins."
      : "Select one environment to edit its folder models.";

  return (
    <SettingsSection title="Model by folder" footer={footer}>
      {props.mixed
        ? null
        : props.rules.map((rule, index) => {
            const model = describe(rule.modelSelection);
            const row = (
              <RowPressable
                key={rule.folder}
                accessibilityRole="button"
                accessibilityLabel={`${rule.folder}, ${model}`}
                disabled={!props.editable}
                className={
                  index > 0 ? "border-t border-border-subtle bg-grouped-card" : "bg-grouped-card"
                }
              >
                <ListRowLayout
                  label={rule.folder}
                  labelTruncatesStart
                  description={model}
                  disabled={!props.editable}
                  accessory={
                    <SymbolView
                      name="ellipsis"
                      size={18}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  }
                />
              </RowPressable>
            );
            return props.editable ? (
              <Menu
                key={rule.folder}
                actions={REMOVE_ACTIONS}
                onPressAction={() =>
                  props.write({
                    folderModelDefaults: props.rules.filter((_, at) => at !== index),
                  })
                }
              >
                {row}
              </Menu>
            ) : (
              row
            );
          })}
      {!props.mixed ? (
        <SettingsRow
          icon="plus"
          label="Add folder"
          disabled={!props.editable}
          onPress={() =>
            navigation.navigate("SettingsFolderModel", { environmentId: props.environmentId })
          }
        />
      ) : null}
    </SettingsSection>
  );
}
