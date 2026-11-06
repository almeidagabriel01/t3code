import { useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_ROLE_MAX_LENGTH,
  type AssistantId,
  type AssistantToolAccess,
  type BudgetPeriod,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  directReports,
  hasStandupTask,
  leaderChoices,
  NO_LEADER_LABEL,
} from "@t3tools/client-runtime/assistantTeam";
import { assistantSandboxView } from "@t3tools/client-runtime/state/assistants";
import type { MenuAction } from "@react-native-menu/menu";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantSpend,
  useAssistantSandbox,
  useAssistantsEnvironmentIds,
} from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
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
import { AssistantIconPicker } from "./AssistantIconPicker";
import { MenuField, SwitchRow, TextField } from "./AssistantFormFields";
import { AssistantConnectorsSection } from "./AssistantConnectorsSection";
import { AssistantNotificationsSection } from "./AssistantNotificationsSection";
import { AssistantSchedulesSection } from "./AssistantSchedulesSection";
import { AssistantWatchesSection } from "./AssistantWatchesSection";
import {
  BUDGET_PERIOD_OPTIONS,
  budgetSpendLine,
  TOOL_ACCESS_OPTIONS,
  WORKSPACE_OPTIONS,
} from "./assistantPresentation";
import { assistantProjectName, useAssistantEditor } from "./useAssistantEditor";
import { useAssistantFlows } from "./useAssistantFlows";

/** Offers the leader's standup until its conversation has one; then points at its schedule. */
function DailyStandupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly reportNames: ReadonlyArray<string>;
  readonly state: "idle" | "adding" | "added";
  readonly disabled: boolean;
  readonly onAdd: () => void;
}) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const exists = props.state === "added" || hasStandupTask(tasks.data?.tasks ?? [], props.threadId);
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          Daily standup
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {exists
            ? "It is in its schedules below, where you can change or remove it."
            : `Weekdays at 9:00 it asks ${props.reportNames.join(", ")} for status and sends you one short report.`}
        </Text>
      </View>
      {exists ? null : (
        <ListSection>
          <ListActionRow
            icon="calendar.badge.clock"
            label="Add daily standup"
            loading={props.state === "adding"}
            disabled={props.disabled}
            onPress={props.onAdd}
          />
        </ListSection>
      )}
    </View>
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
  const { projects, effectiveProject, modelLabel, modelSelection, globalAutonomy } =
    useAssistantEditor();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const actions = useAssistantActions(environmentId);
  const sandboxView = assistantSandboxView(useAssistantSandbox(environmentId));
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
  const [standup, setStandup] = useState<"idle" | "adding" | "added">("idle");
  // Set once the save lands, so the removal guard lets the form close.
  const closing = useRef(false);

  const team = [...entries.active, ...entries.archived]
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.assistant);
  const leaders = leaderChoices(team, assistant?.id ?? null);
  const reports = live ? directReports(team, live.id) : [];
  const addStandup = async () => {
    if (!live) return;
    setStandup("adding");
    setError(null);
    const reply = await actions.update({ assistantId: live.id, addStandup: true });
    setStandup(reply.ok ? "added" : "idle");
    if (!reply.ok) setError(reply.message);
  };

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

  const projectOptions = projects.map((project) => ({
    id: project.id,
    label: assistantProjectName(project),
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
              Model and effort
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
        <AssistantIconPicker
          value={current.icon}
          name={current.name}
          onChange={(icon) => updateAssistantDraft({ icon })}
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
              Workspace
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              Where it runs commands and edits files. Its tool access applies there.
            </Text>
          </View>
          <ListSection>
            {WORKSPACE_OPTIONS.map((option) => {
              const unavailable = option.value === "sandbox" ? sandboxView.unavailableReason : null;
              return (
                <RowPressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityHint={unavailable ?? option.description}
                  accessibilityState={{
                    selected: current.workspace === option.value,
                    disabled: unavailable !== null,
                  }}
                  disabled={unavailable !== null}
                  onPress={() => updateAssistantDraft({ workspace: option.value })}
                  className="bg-grouped-card"
                >
                  <ListRowLayout
                    icon={option.icon}
                    label={option.label}
                    description={unavailable ?? option.description}
                    disabled={unavailable !== null}
                    accessory={
                      current.workspace === option.value ? (
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
              );
            })}
          </ListSection>
        </View>
        <View className="gap-2">
          <View className="gap-0.5 px-2">
            <Text textRole="footnote" className="font-t3-medium text-foreground">
              Ask before acting
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              Before this assistant sends anything into another conversation, it asks you here and
              waits for your approval.
            </Text>
          </View>
          <ListSection>
            <SwitchRow
              icon="checkmark.circle"
              label="Ask before acting"
              value={current.askBeforeActing}
              onChange={(askBeforeActing) => updateAssistantDraft({ askBeforeActing })}
            />
          </ListSection>
        </View>
        <TextField
          label="Role"
          description="What it is to the others, such as CEO or Engineer. Agents see it."
          value={current.role}
          maxLength={ASSISTANT_ROLE_MAX_LENGTH}
          placeholder="CEO, Engineer…"
          autoCapitalize="sentences"
          onChange={(role) => updateAssistantDraft({ role })}
        />
        <MenuField
          label="Reports to"
          description="Its leader can ask it for work and gets the answer back. It never messages up on its own."
          value={leaders.find((leader) => leader.id === current.reportsTo)?.name ?? NO_LEADER_LABEL}
          actions={[
            { id: "", title: NO_LEADER_LABEL, state: current.reportsTo === null ? "on" : "off" },
            ...leaders.map((leader) => ({
              id: leader.id,
              title: leader.name,
              state: leader.id === current.reportsTo ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) =>
            updateAssistantDraft({ reportsTo: id === "" ? null : (id as AssistantId) })
          }
        />
        {live && environmentId !== null && reports.length > 0 ? (
          <DailyStandupSection
            environmentId={environmentId}
            threadId={live.threadId}
            reportNames={reports.map((report) => report.name)}
            state={standup}
            disabled={!actions.canAct}
            onAdd={() => void addStandup()}
          />
        ) : null}
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
        <AssistantConnectorsSection
          value={current.connectors}
          onChange={(connectors) => updateAssistantDraft({ connectors })}
        />
        <AssistantNotificationsSection
          value={current.autonomy}
          onChange={(autonomy) => updateAssistantDraft({ autonomy })}
          globalAutonomy={globalAutonomy}
          projects={projectOptions}
          defaultProjectId={effectiveProject?.id ?? null}
        />
        {assistant?.threadId ? (
          <AssistantSchedulesSection
            environmentId={environmentId}
            environmentLabel={environmentLabel(environmentId)}
            assistant={assistant}
            modelSelection={modelSelection}
          />
        ) : null}
        {assistant ? (
          <AssistantWatchesSection
            environmentId={environmentId}
            assistantId={assistant.id}
            notifies={current.autonomy.mode === "reply-and-notify"}
            projects={projectOptions}
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
            {live.archivedAt === null ? (
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
            <ListActionRow
              icon="trash"
              tone="danger"
              label="Delete assistant"
              description="Permanently deletes it and every conversation it had."
              disabled={!flows.canAct}
              onPress={() => flows.remove(live, close)}
            />
          </ListSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
