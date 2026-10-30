import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import {
  MAX_FALLBACK_MODEL_SELECTIONS,
  type EnvironmentId,
  type ModelSelection,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  fallbackModelsPatch,
  moveFallbackModel,
  removeFallbackModel,
} from "@t3tools/shared/serverSettings";
import { useMemo } from "react";

import { Menu } from "../../../components/ui/Menu";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { RowPressable } from "../../../components/ui/RowPressable";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { buildModelOptions } from "../../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/** The ordered models new threads fall back to when the default model's provider is out of usage. */
export function FallbackModelsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly chain: ReadonlyArray<ModelSelection>;
  /** Editing needs one environment: the chain is per environment, and the picker saves to one. */
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
    return { name: option?.label ?? selection.model, provider: option?.providerLabel };
  };
  const actions = (index: number): MenuAction[] => [
    { id: "up", title: "Move up", attributes: { disabled: index === 0 } },
    { id: "down", title: "Move down", attributes: { disabled: index === props.chain.length - 1 } },
    { id: "remove", title: "Remove", attributes: { destructive: true } },
  ];
  const footer = props.mixed
    ? "These environments differ. Select one to edit its fallback models."
    : props.editable
      ? "Tried in order for new threads when the default model's provider is out of usage."
      : "Select one environment to edit its fallback models.";

  return (
    <SettingsSection title="Fallback models" footer={footer}>
      {props.mixed
        ? null
        : props.chain.map((selection, index) => {
            const { name, provider } = describe(selection);
            const row = (
              <RowPressable
                accessibilityRole="button"
                accessibilityLabel={`${index + 1}. ${name}${provider ? `, ${provider}` : ""}`}
                disabled={!props.editable}
                className={
                  index > 0 ? "border-t border-border-subtle bg-grouped-card" : "bg-grouped-card"
                }
              >
                <ListRowLayout
                  label={`${index + 1}. ${name}`}
                  {...(provider ? { description: provider } : {})}
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
                key={`${selection.instanceId}:${selection.model}`}
                actions={actions(index)}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "up")
                    props.write(fallbackModelsPatch(moveFallbackModel(props.chain, index, -1)));
                  else if (nativeEvent.event === "down")
                    props.write(fallbackModelsPatch(moveFallbackModel(props.chain, index, 1)));
                  else if (nativeEvent.event === "remove")
                    props.write(fallbackModelsPatch(removeFallbackModel(props.chain, index)));
                }}
              >
                {row}
              </Menu>
            ) : (
              row
            );
          })}
      {!props.mixed && props.chain.length < MAX_FALLBACK_MODEL_SELECTIONS ? (
        <SettingsRow
          icon="plus"
          label="Add model"
          disabled={!props.editable}
          onPress={() =>
            navigation.navigate("SettingsFallbackModel", { environmentId: props.environmentId })
          }
        />
      ) : null}
    </SettingsSection>
  );
}
