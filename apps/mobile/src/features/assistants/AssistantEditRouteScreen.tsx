import { useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_LENGTH,
  type AssistantToolAccess,
  type BudgetPeriod,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantSpend,
  useAssistantsEnvironmentIds,
} from "../../state/assistants";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  assistantCreateInput,
  assistantDraftHasChanges,
  assistantProjectChanged,
  assistantUpdateInput,
  changeAssistantEditorEnvironment,
  discardAssistantEditor,
  effectiveAssistantHandle,
  isAssistantHandleValid,
  isBudgetDraftValid,
  updateAssistantDraft,
  type AssistantEditor,
} from "./assistantDraft";
import { AssistantSchedulesSection } from "./AssistantSchedulesSection";
import {
  BUDGET_PERIOD_OPTIONS,
  budgetSpendLine,
  TOOL_ACCESS_OPTIONS,
} from "./assistantPresentation";
import { assistantProjectName, useAssistantEditor } from "./useAssistantEditor";
import { useAssistantFlows } from "./useAssistantFlows";

function Field(props: {
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          {props.label}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {props.description}
        </Text>
      </View>
      <View className="overflow-hidden rounded-2xl bg-grouped-card px-4 py-3">
        {props.children}
      </View>
      {props.footer}
    </View>
  );
}

function TextField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly autoCapitalize?: "none" | "sentences";
  readonly keyboardType?: "decimal-pad" | "number-pad";
  readonly footer?: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <Field label={props.label} description={props.description} footer={props.footer}>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        maxLength={props.maxLength}
        multiline={props.multiline}
        autoCapitalize={props.autoCapitalize}
        keyboardType={props.keyboardType}
        autoCorrect={false}
        textAlignVertical={props.multiline ? "top" : "center"}
        placeholderTextColorClassName="accent-foreground-muted"
        className={
          props.multiline
            ? "min-h-36 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </Field>
  );
}

function SwitchRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View className="bg-grouped-card">
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        accessory={
          <ThemedSwitch
            accessibilityLabel={props.label}
            value={props.value}
            onValueChange={props.onChange}
          />
        }
      />
    </View>
  );
}

function MenuField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly footer?: ReactNode;
}) {
  return (
    <Field label={props.label} description={props.description} footer={props.footer}>
      <Menu
        actions={props.actions}
        onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.label}, ${props.value}`}
          className="min-h-8 flex-row items-center gap-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
            {props.value}
          </Text>
          <SymbolView
            name="chevron.down"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </Field>
  );
}

export function AssistantEditRouteScreen() {
  const { editor } = useAssistantEditor();
  if (!editor) {
    return (
      <SettingsScreen title="Assistant">
        <Text className="p-5 text-base text-foreground-muted">Open an assistant form first.</Text>
      </SettingsScreen>
    );
  }
  return <AssistantForm editor={editor} />;
}

function AssistantForm(props: { readonly editor: AssistantEditor }) {
  const { editor } = props;
  const { assistant, current, environmentId } = editor;
  const { projects, effectiveProject, modelLabel, modelSelection } = useAssistantEditor();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const actions = useAssistantActions(environmentId);
  const flows = useAssistantFlows(environmentId);
  const entries = useAssistantEntries();
  // The form edits the assistant as it was opened; Manage acts on it as it is now.
  const live =
    [...entries.active, ...entries.archived].find((entry) => entry.assistant.id === assistant?.id)
      ?.assistant ?? assistant;
  const environmentIds = useAssistantsEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentLabel = (id: EnvironmentId) =>
    savedConnectionsById[id]?.environmentLabel ?? String(id);
  const spend = useAssistantSpend(environmentId, assistant?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set once the save lands, so the removal guard lets the form close.
  const closing = useRef(false);

  const budget = current.budget;
  const updateBudget = (change: Partial<typeof budget>) =>
    updateAssistantDraft({ budget: { ...budget, ...change } });
  const spendLine = spend.data ? budgetSpendLine(spend.data) : null;
  const handle = effectiveAssistantHandle(current);
  const handleValid = isAssistantHandleValid(handle);
  // An untouched new form isn't wrong yet; flag the handle once there is something to check.
  const showHandleError = !handleValid && (current.handle !== null || current.name.trim() !== "");
  const projectChanged = assistantProjectChanged(assistant, effectiveProject?.id ?? null);
  const hasChanges = assistantDraftHasChanges(editor);
  const canSave =
    !saving &&
    actions.canAct &&
    current.name.trim().length > 0 &&
    handleValid &&
    effectiveProject !== null &&
    isBudgetDraftValid(current.budget) &&
    (assistant === null || hasChanges);

  const close = () => {
    closing.current = true;
    navigation.goBack();
    discardAssistantEditor();
  };
  const preventRemove = hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (closing.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving", "Wait for the assistant to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => {
          closing.current = true;
          discardAssistantEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  const save = async () => {
    if (!canSave || effectiveProject === null) return;
    setSaving(true);
    setError(null);
    const reply =
      assistant === null
        ? await actions.create(assistantCreateInput(editor, effectiveProject.id))
        : await actions.update(assistantUpdateInput({ ...editor, assistant }, effectiveProject.id));
    setSaving(false);
    if (reply.ok) close();
    else setError(reply.message);
  };

  const projectActions: MenuAction[] = projects.map((project) => ({
    id: project.id,
    title: assistantProjectName(project),
    state: project.id === effectiveProject?.id ? "on" : "off",
  }));

  return (
    <SettingsScreen title={assistant ? `${assistant.name} settings` : "New assistant"}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: "Back",
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {assistant === null && environmentIds.length > 1 ? (
          <MenuField
            label="Environment"
            description="The server that runs this assistant."
            value={environmentLabel(environmentId)}
            actions={environmentIds.map((id) => ({
              id,
              title: environmentLabel(id),
              state: id === environmentId ? "on" : "off",
            }))}
            onSelect={(id) => changeAssistantEditorEnvironment(id as EnvironmentId)}
          />
        ) : null}
        <TextField
          label="Name"
          description="Shown on Home and at the top of its conversation."
          value={current.name}
          maxLength={ASSISTANT_NAME_MAX_LENGTH}
          autoCapitalize="sentences"
          onChange={(name) => updateAssistantDraft({ name })}
        />
        <TextField
          label="Handle"
          description="How channels and agents address it. Lowercase letters, numbers and dashes."
          value={handle}
          autoCapitalize="none"
          onChange={(value) => updateAssistantDraft({ handle: value.toLowerCase() })}
          footer={
            !showHandleError ? null : (
              <Text textRole="footnote" className="px-2 text-danger-foreground">
                Use 1 to 32 lowercase letters, numbers or dashes, starting and ending with a letter
                or number.
              </Text>
            )
          }
        />
        <MenuField
          label="Project"
          description="The folder it works in, and whose memory it shares."
          value={
            effectiveProject ? assistantProjectName(effectiveProject) : "No projects available"
          }
          actions={projectActions}
          onSelect={(id) => updateAssistantDraft({ projectId: id as ProjectId })}
          footer={
            projectChanged ? (
              <Text textRole="footnote" className="px-2 text-warning-foreground">
                Changing the project starts a new conversation. The current one moves to Archive,
                where you can restore it.
              </Text>
            ) : null
          }
        />
        <View className="gap-2">
          <View className="gap-0.5 px-2">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              Model
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {assistant
                ? "Applies to its current conversation."
                : "Starts on your default model unless you choose another."}
            </Text>
          </View>
          <ListSection>
            <ListRow
              icon="cube"
              label={modelLabel ?? "No providers available"}
              disabled={modelLabel === null}
              onPress={() => navigation.navigate("SettingsAssistantModel")}
            />
          </ListSection>
        </View>
        <TextField
          label="Instructions"
          description="Standing guidance sent with every turn: its role, tone and rules."
          value={current.instructions}
          maxLength={ASSISTANT_INSTRUCTIONS_MAX_CHARS}
          multiline
          autoCapitalize="sentences"
          onChange={(instructions) => updateAssistantDraft({ instructions })}
          footer={
            <Text textRole="footnote" className="px-2 text-right text-foreground-muted">
              {current.instructions.length.toLocaleString()} /{" "}
              {ASSISTANT_INSTRUCTIONS_MAX_CHARS.toLocaleString()}
            </Text>
          }
        />
        <View className="gap-2">
          <View className="gap-0.5 px-2">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              Tool access
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              What it may do without asking. Enforced by the conversation's permissions.
            </Text>
          </View>
          <ListSection>
            {TOOL_ACCESS_OPTIONS.map((option) => (
              <RowPressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityHint={option.description}
                accessibilityState={{ selected: current.toolAccess === option.value }}
                onPress={() =>
                  updateAssistantDraft({ toolAccess: option.value as AssistantToolAccess })
                }
                className="bg-grouped-card"
              >
                <ListRowLayout
                  icon={option.icon}
                  label={option.label}
                  description={option.description}
                  accessory={
                    current.toolAccess === option.value ? (
                      <SymbolView
                        name="checkmark"
                        size={16}
                        tintColorClassName="accent-icon"
                        type="monochrome"
                        weight="semibold"
                      />
                    ) : undefined
                  }
                />
              </RowPressable>
            ))}
          </ListSection>
        </View>
        <View className="gap-2">
          <View className="gap-0.5 px-2">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              Spending limit
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              Caps what it may spend across all its conversations, estimated at API prices.
            </Text>
          </View>
          <ListSection>
            <SwitchRow
              icon="chart.bar.xaxis"
              label="Limit spending"
              value={budget.enabled}
              onChange={(enabled) => updateBudget({ enabled })}
            />
          </ListSection>
          {spendLine ? (
            <Text textRole="footnote" className="px-2 text-foreground-muted">
              {spendLine}
            </Text>
          ) : null}
        </View>
        {budget.enabled ? (
          <>
            <TextField
              label="Amount (USD)"
              description="The most it may spend in each period."
              value={budget.amount}
              keyboardType="decimal-pad"
              autoCapitalize="none"
              onChange={(amount) => updateBudget({ amount })}
              footer={
                isBudgetDraftValid(budget) || budget.amount === "" ? null : (
                  <Text textRole="footnote" className="px-2 text-danger-foreground">
                    Enter an amount above zero and a warning between 1 and 100.
                  </Text>
                )
              }
            />
            <View className="gap-2">
              <View className="gap-0.5 px-2">
                <Text textRole="footnote" className="font-t3-medium text-foreground">
                  Period
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  How often the spending count starts over.
                </Text>
              </View>
              <ListSection>
                {BUDGET_PERIOD_OPTIONS.map((option) => (
                  <RowPressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: budget.period === option.value }}
                    onPress={() => updateBudget({ period: option.value as BudgetPeriod })}
                    className="bg-grouped-card"
                  >
                    <ListRowLayout
                      icon={option.icon}
                      label={option.label}
                      accessory={
                        budget.period === option.value ? (
                          <SymbolView
                            name="checkmark"
                            size={16}
                            tintColorClassName="accent-icon"
                            type="monochrome"
                            weight="semibold"
                          />
                        ) : undefined
                      }
                    />
                  </RowPressable>
                ))}
              </ListSection>
            </View>
            <TextField
              label="Warn at (%)"
              description="Shows a warning once this share of the limit is spent."
              value={budget.warnAt}
              keyboardType="number-pad"
              autoCapitalize="none"
              onChange={(warnAt) => updateBudget({ warnAt })}
            />
            <View className="gap-2">
              <View className="gap-0.5 px-2">
                <Text textRole="footnote" className="font-t3-medium text-foreground">
                  When the limit is reached
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  Off keeps it running and only warns.
                </Text>
              </View>
              <ListSection>
                <SwitchRow
                  icon="stop.fill"
                  label="Stop when reached"
                  value={budget.block}
                  onChange={(block) => updateBudget({ block })}
                />
              </ListSection>
            </View>
          </>
        ) : null}
        <View className="gap-2">
          <View className="gap-0.5 px-2">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              Memory
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              Give the assistant its own project to keep its memory apart.
            </Text>
          </View>
          <ListSection>
            <ListRow
              icon="brain"
              label={
                effectiveProject
                  ? `Shared with ${assistantProjectName(effectiveProject)}`
                  : "Memory follows the assistant's project"
              }
              description="Open Memory settings"
              onPress={() => navigation.navigate("SettingsMemory")}
            />
          </ListSection>
        </View>
        {assistant?.threadId ? (
          <AssistantSchedulesSection
            environmentId={environmentId}
            environmentLabel={environmentLabel(environmentId)}
            assistant={assistant}
            modelSelection={modelSelection}
          />
        ) : null}
        {error ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        <Button
          label={assistant ? "Save" : "Create assistant"}
          tone="primary"
          fullWidth
          loading={saving}
          disabled={!canSave}
          onPress={() => void save()}
        />
        {live ? (
          <ListSection title="Manage">
            <ListActionRow
              icon="arrow.clockwise"
              label="Reset conversation"
              description="Start a new conversation. The current one moves to Archive."
              disabled={!flows.canAct || live.threadId === null}
              onPress={() => flows.reset(live, { openAfter: true })}
            />
            {live.isDefault ? null : live.archivedAt === null ? (
              <ListActionRow
                icon="archivebox"
                label="Archive assistant"
                description="Leaves Home. Its conversation and settings are kept."
                disabled={!flows.canAct}
                onPress={() => flows.archive(live)}
              />
            ) : (
              <ListActionRow
                icon="arrow.uturn.backward"
                label="Unarchive assistant"
                description="Brings it back to Home."
                disabled={!flows.canAct}
                onPress={() => void flows.unarchive(live)}
              />
            )}
            {live.isDefault ? null : (
              <ListActionRow
                icon="trash"
                tone="danger"
                label="Delete assistant"
                description="Permanently deletes it and every conversation it had."
                disabled={!flows.canAct}
                onPress={() => flows.remove(live, close)}
              />
            )}
          </ListSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
