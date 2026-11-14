import {
  assistantIntegrationPicker,
  integrationProviderSupport,
  integrationStatusLabel,
  notAvailableOnLabel,
  sandboxWorkNote,
  selectionForMode,
  toggleIntegration,
} from "@t3tools/client-runtime/integrations";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { AssistantIntegrations, AssistantWorkspace, EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useIntegrationsState } from "../../state/integrations";
import { IntegrationChip } from "../integrations/IntegrationParts";
import { ChoiceRow, FieldHeader } from "./AssistantFormFields";

/** All connected, or a checklist; native copies of the assistant's provider stay on and greyed out. */
export function AssistantIntegrationsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string | null;
  readonly workspace: AssistantWorkspace;
  readonly value: AssistantIntegrations;
  readonly onChange: (next: AssistantIntegrations) => void;
}) {
  const state = useIntegrationsState(props.environmentId);
  const config = useEnvironmentServerConfig(props.environmentId);
  const navigation = useNavigation();
  if (state === null) return null;
  const provider = config?.providers.find((item) => item.instanceId === props.instanceId);
  const picker = assistantIntegrationPicker({
    state,
    selection: props.value,
    driverKind: provider?.driver ?? "",
    instanceId: props.instanceId ?? "",
  });
  const unsupported = provider !== undefined && !integrationProviderSupport(provider.driver);
  return (
    <View className="gap-2">
      <FieldHeader
        label="Integrations"
        description={[
          "Services it can use, such as your calendar or email. Changes it makes there follow its tool access.",
          unsupported
            ? notAvailableOnLabel(resolveProviderInstanceDisplayName(provider))
            : sandboxWorkNote(props.workspace),
        ]
          .filter((line) => line !== null)
          .join("\n")}
      />
      <ListSection>
        <ChoiceRow
          role="radio"
          label="All connected"
          selected={props.value.mode === "all"}
          onPress={() => props.onChange(selectionForMode("all", props.value, state))}
        />
        <ChoiceRow
          role="radio"
          label="Choose…"
          selected={props.value.mode === "selected"}
          onPress={() => props.onChange(selectionForMode("selected", props.value, state))}
        />
      </ListSection>
      {picker.mode === "selected" && picker.items.length === 0 ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="No integrations to choose yet. Connect one in Settings → Integrations."
          onPress={() => navigation.navigate("SettingsIntegrations")}
          className="min-h-11 justify-center px-2 active:opacity-70"
        >
          <Text textRole="footnote" className="text-foreground-muted">
            No integrations to choose yet. Connect one in{" "}
            <Text textRole="footnote" className="text-foreground underline">
              Settings → Integrations
            </Text>
            .
          </Text>
        </Pressable>
      ) : null}
      {picker.mode === "all" || picker.items.length === 0 ? null : (
        <ListSection>
          {picker.items.map((item) => (
            <RowPressable
              key={item.key}
              accessibilityRole="checkbox"
              accessibilityLabel={item.title}
              accessibilityHint={item.note ?? item.status?.label}
              accessibilityState={{ checked: item.selected, disabled: item.disabled }}
              disabled={item.disabled}
              onPress={() => props.onChange(toggleIntegration(props.value, item.name))}
              className="bg-grouped-card"
            >
              <ListRowLayout
                label={item.title}
                description={item.note ?? item.status?.label}
                disabled={item.disabled}
                accessory={
                  <SymbolView
                    name={item.selected ? "checkmark.circle.fill" : "circle"}
                    size={20}
                    tintColorClassName={item.selected ? "accent-icon" : "accent-icon-subtle"}
                    type="monochrome"
                  />
                }
              />
            </RowPressable>
          ))}
        </ListSection>
      )}
    </View>
  );
}

/** The T3 integrations an assistant gets, with a warning chip on any that needs attention. */
export function AssistantIntegrationChips(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: AssistantIntegrations;
}) {
  const state = useIntegrationsState(props.environmentId);
  const used = (state?.integrations ?? []).filter(
    (item) =>
      item.status !== "not-connected" &&
      (props.selection.mode === "all" || props.selection.names.includes(item.name)),
  );
  if (state === null || used.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1">
      {used.map((item) => {
        const status = integrationStatusLabel(item.status);
        const title = state.catalog.find((entry) => entry.id === item.catalogId)?.name ?? item.name;
        return (
          <IntegrationChip
            key={item.name}
            label={`${title} · ${status.label}`}
            tone={status.tone === "warning" || status.tone === "danger" ? "warning" : "muted"}
          />
        );
      })}
    </View>
  );
}
