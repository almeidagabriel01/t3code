import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_RETRY_TEXT,
  assistantRetryPlan,
  assistantWorkStatus,
  type AssistantWorkFix,
} from "@t3tools/client-runtime/assistantWork";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  useAssistantEntries,
  useAssistantSandbox,
  useAssistantSandboxActions,
} from "../../state/assistants";
import { useEnvironmentServerConfig, useProjects, useThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAutonomySettings } from "../../state/autonomy";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AssistantSchedulesSection } from "./AssistantSchedulesSection";
import { AssistantWorkLibrarySection } from "./AssistantWorkLibrarySection";
import { AssistantWorkMemorySection } from "./AssistantWorkMemorySection";
import { assistantWorkTargetAtom } from "./assistantWorkTarget";
import { useOpenAssistantEditor } from "./openAssistantEditor";

/** Whether the assistant can work now, and what it runs, remembers and has handed over. */
export function AssistantWorkRouteScreen() {
  const target = useAtomValue(assistantWorkTargetAtom);
  const { active } = useAssistantEntries();
  const entry =
    target === null
      ? undefined
      : active.find(
          (candidate) =>
            candidate.environmentId === target.environmentId &&
            candidate.assistant.id === target.assistantId,
        );
  if (entry === undefined) {
    return (
      <SettingsScreen title="Work">
        <View className="px-5 pt-4">
          <Text textRole="footnote" className="text-foreground-muted">
            This assistant is not available. Go back and choose one.
          </Text>
        </View>
      </SettingsScreen>
    );
  }
  return (
    <SettingsScreen title={`${entry.assistant.name} work`}>
      <AssistantWork
        environmentId={entry.environmentId as EnvironmentId}
        assistant={entry.assistant}
      />
    </SettingsScreen>
  );
}

function AssistantWork(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}) {
  const { environmentId, assistant } = props;
  const shell = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  return (
    <ScrollView contentContainerClassName="gap-6 px-5 pt-4 pb-10">
      <StatusSection environmentId={environmentId} assistant={assistant} />
      <AssistantSchedulesSection
        environmentId={environmentId}
        environmentLabel=""
        assistant={assistant}
        modelSelection={shell?.modelSelection ?? null}
      />
      <AssistantWorkMemorySection environmentId={environmentId} assistant={assistant} />
      <AssistantWorkLibrarySection environmentId={environmentId} assistant={assistant} />
    </ScrollView>
  );
}

function StatusSection(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
}) {
  const { environmentId, assistant } = props;
  const navigation = useNavigation();
  const openEditor = useOpenAssistantEditor();
  const projects = useProjects();
  const shell = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const providers = useEnvironmentServerConfig(environmentId)?.providers ?? null;
  const sandbox = useAssistantSandbox(environmentId);
  const sandboxActions = useAssistantSandboxActions(environmentId);
  const { autonomy, write } = useAutonomySettings(environmentId);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "assistant retry");
  const [retrying, setRetrying] = useState(false);

  const status = assistantWorkStatus({
    assistant,
    projectFound: projects.some(
      (project) => project.environmentId === environmentId && project.id === assistant.projectId,
    ),
    modelSelection: shell?.modelSelection ?? null,
    providers,
    sandbox: assistant.workspace === "sandbox" ? sandbox : null,
    autonomyEnabled: autonomy.enabled,
  });
  const retry = assistantRetryPlan(shell);

  const fix = async (kind: AssistantWorkFix) => {
    switch (kind) {
      case "providers":
        return navigation.navigate("SettingsProviderAccounts");
      case "editAssistant":
        return openEditor(environmentId, assistant);
      case "restore":
        return;
      case "resumeAutonomy":
        return void write({ ...autonomy, enabled: true });
      case "startSandbox": {
        const reply = await sandboxActions.start();
        if (!reply.ok) Dialog.alert("Could not start the sandbox", reply.message);
      }
    }
  };

  const retryRun = async () => {
    if (retry === null || shell === null || retrying) return;
    setRetrying(true);
    const result = await startTurn({
      environmentId,
      input: {
        creationSource: "mobile",
        threadId: shell.id,
        ...(retry.kind === "continue" ? { manualContinuationOfRunId: retry.runId } : {}),
        modelSelection: shell.modelSelection,
        message: {
          messageId: Crypto.randomUUID() as never,
          role: "user",
          text: ASSISTANT_RETRY_TEXT[retry.kind],
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "start",
      },
    });
    setRetrying(false);
    return result;
  };

  return (
    <View className="gap-2">
      <ListSection>
        <View className="bg-grouped-card">
          <ListRowLayout
            icon={status.ok ? "checkmark.circle" : "exclamationmark.triangle"}
            label={status.ok ? "Ready to work" : status.title}
            description={status.ok ? "Nothing is in its way." : status.detail}
          />
        </View>
        {!status.ok && status.fix !== null ? (
          <ListActionRow
            icon="arrow.right.circle"
            label={status.fix.label}
            onPress={() => void fix(status.fix!.kind)}
          />
        ) : null}
        {retry === null ? null : (
          <ListActionRow
            icon="arrow.clockwise"
            label="Retry"
            description={
              shell?.latestRun?.status === "failed"
                ? "Its last run failed."
                : "Its last run was stopped."
            }
            loading={retrying}
            onPress={() => void retryRun()}
          />
        )}
      </ListSection>
    </View>
  );
}
