import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  THREAD_HANDOFF_INSTRUCTIONS_MAX_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadHandoffMode,
  type ThreadId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import { Platform, ScrollView, TextInput, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useProjects, useQuietThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  buildHandoffInput,
  canStartHandoff,
  DEFAULT_HANDOFF_MODE,
  findHandoffOption,
  HANDOFF_LABEL,
  resolveHandoffAgents,
  resolveHandoffContextChoices,
} from "./thread-handoff";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export type ThreadHandoffParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
};

/** The agent picked in the picker route, for the one thread whose hand-off sheet is open. */
const pickedAgentAtom = Atom.make<{
  readonly threadKey: string;
  readonly selection: ModelSelection;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("thread-handoff:picked-agent"));

function useHandoffAgent(target: ThreadHandoffParams) {
  const threadRef = scopeThreadRef(target.environmentId, target.threadId);
  const thread = useQuietThreadShell(threadRef);
  const picked = useAtomValue(pickedAgentAtom);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const selection =
    picked?.threadKey === threadKey ? picked.selection : (thread?.modelSelection ?? null);
  return { thread, selection, threadKey };
}

export function ThreadHandoffSheet({ route }: StaticScreenProps<ThreadHandoffParams>) {
  const target = route.params;
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { thread, selection } = useHandoffAgent(target);
  const project = useProjects().find(
    (entry) => entry.environmentId === target.environmentId && entry.id === thread?.projectId,
  );
  const config = useEnvironmentServerConfig(target.environmentId);
  const canHandoff = useAtomValue(
    orchestrationEnvironment.handoffThread.permissionAtom(target.environmentId),
  );
  const handoff = useAtomCommand(orchestrationEnvironment.handoffThread, {
    reportFailure: false,
  });
  const [mode, setMode] = useState<OrchestrationV2ThreadHandoffMode>(DEFAULT_HANDOFF_MODE);
  const [instructions, setInstructions] = useState("");
  // One id per sheet, so a retry after a dropped reply returns the thread the first call started.
  const [clientRequestId] = useState(uuidv4);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pick belongs to this sheet; the next one starts from the thread's own model.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears a registry entry held until the sheet unmounts
  useEffect(() => () => appAtomRegistry.set(pickedAgentAtom, null), []);

  const options = useMemo(
    () =>
      buildModelOptions(
        config,
        thread?.modelSelection ?? null,
        undefined,
        thread?.projectId ?? null,
      ),
    [config, thread?.modelSelection, thread?.projectId],
  );
  const { agentOption, agentLabel, sourceLabel } = resolveHandoffAgents({
    options,
    selection,
    source: thread?.modelSelection,
  });
  const contextChoices = resolveHandoffContextChoices(config);
  const contextChoice = contextChoices.find((choice) => choice.mode === mode);
  // A summary that became unavailable after it was picked is not sent.
  const effectiveMode = contextChoice?.disabled === false ? mode : DEFAULT_HANDOFF_MODE;
  const startsIn = thread?.worktreePath ?? project?.workspaceRoot ?? null;

  const start = async () => {
    if (selection === null || starting) return;
    setStarting(true);
    setError(null);
    void Haptics.selectionAsync();
    const result = await handoff({
      environmentId: target.environmentId,
      input: buildHandoffInput({
        sourceThreadId: target.threadId,
        modelSelection: selection,
        mode: effectiveMode,
        clientRequestId,
        instructions,
      }),
    });
    if (result._tag !== "Success") {
      setStarting(false);
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not start the new session.");
      return;
    }
    const nextRef = scopeThreadRef(target.environmentId, result.value.threadId);
    const ready = await waitForThreadShellReady({
      read: () => appAtomRegistry.get(environmentThreadShells.threadShellAtom(nextRef)) !== null,
    });
    setStarting(false);
    if (!ready) {
      setError(
        "The new session started, but it has not reached this device yet. Open it from the thread list.",
      );
      return;
    }
    // Replace this leaf sheet so the new thread enters the workspace stack Home's Back button expects.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: result.value.threadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pt-2"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <Text className="text-sm text-foreground-muted">
        Start a fresh session from this stopping point. The original session stays unchanged.
      </Text>
      <View className="gap-0.5 rounded-2xl bg-grouped-card px-4 py-3">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {thread?.title ?? "Current session"}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {`Agent: ${sourceLabel}`}
        </Text>
      </View>
      <ListSection title="Agent">
        <NavigationRow
          title={agentLabel}
          subtitle={agentOption?.providerLabel}
          leading={
            agentOption === undefined ? undefined : (
              <ProviderIcon
                iconUrl={agentOption.providerIconUrl}
                provider={agentOption.providerDriver}
                size={20}
              />
            )
          }
          disabled={starting}
          accessibilityHint="Choose which agent continues the work"
          onPress={() => navigation.navigate("ThreadHandoffAgent", target)}
        />
      </ListSection>
      <ListSection
        title="Context"
        footer={contextChoices.find((c) => c.mode === effectiveMode)?.description}
      >
        {contextChoices.map((choice, index) => (
          <ListChoiceRow
            key={choice.mode}
            label={choice.label}
            selected={effectiveMode === choice.mode}
            separated={index > 0}
            disabled={starting || choice.disabled}
            onPress={() => setMode(choice.mode)}
          />
        ))}
      </ListSection>
      <ListSection
        title="What should it do next?"
        footer="Optional. Goes at the top of the new agent's first message."
      >
        <View className="px-4 py-3">
          <TextInput
            multiline
            accessibilityLabel="What should it do next?"
            value={instructions}
            onChangeText={setInstructions}
            editable={!starting}
            maxLength={THREAD_HANDOFF_INSTRUCTIONS_MAX_CHARS}
            textAlignVertical="top"
            placeholder="Optional"
            placeholderTextColorClassName="accent-foreground-muted"
            className="max-h-40 min-h-20 font-sans text-base text-foreground"
          />
        </View>
      </ListSection>
      {startsIn === null ? null : (
        <View className="flex-row gap-1">
          <Text className="text-xs text-foreground-muted">Starts in</Text>
          <Text
            className="flex-1 font-mono text-xs text-foreground"
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {startsIn}
          </Text>
        </View>
      )}
      {error === null ? null : <ErrorBanner message={error} />}
      <Button
        label={starting && effectiveMode === "summary" ? "Summarizing…" : "Start new session"}
        tone="primary"
        fullWidth
        loading={starting}
        disabled={!canStartHandoff({ permitted: canHandoff, selection, starting })}
        onPress={() => void start()}
      />
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // Plain formSheets lack stack headers; host one in a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-handoff-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title={HANDOFF_LABEL}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title={HANDOFF_LABEL} onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

/** Picks the agent for a hand-off from the same catalog the thread's model picker shows. */
export function ThreadHandoffAgentRouteScreen({ route }: StaticScreenProps<ThreadHandoffParams>) {
  const target = route.params;
  const navigation = useNavigation();
  const { thread, selection, threadKey } = useHandoffAgent(target);
  const config = useEnvironmentServerConfig(target.environmentId);
  const projectId = thread?.projectId ?? null;
  const models = useMemo(
    () => buildModelOptions(config, selection, undefined, projectId),
    [config, selection, projectId],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = findHandoffOption(models, selection);
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selection?.options,
      }),
    [selectedOption?.capabilities, selection?.options],
  );
  const pick = (next: ModelSelection) =>
    appAtomRegistry.set(pickedAgentAtom, { threadKey, selection: next });
  return (
    <ThreadSettingsPickerScreen
      environmentId={target.environmentId}
      projectId={projectId}
      providerGroups={providerGroups}
      selectedModel={selection}
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => pick(option.selection)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (selection) pick({ ...selection, options });
      }}
      runtimeMode="full-access"
      onUpdateRuntimeMode={() => {}}
      runtimeHidden
      onClose={() => navigation.goBack()}
    />
  );
}
