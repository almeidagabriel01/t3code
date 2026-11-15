import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_RETRY_TEXT,
  assistantRetryPlan,
  assistantWorkHeadline,
  assistantWorkStatus,
  type AssistantWorkFix,
  type AssistantWorkHeadline,
} from "@t3tools/client-runtime/assistantWork";
import { environmentReachable } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleEllipsisIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  WifiOffIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { newMessageId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  useAssistantEntries,
  useAssistantSandbox,
  useAssistantSandboxActions,
} from "../../state/assistants";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentPresentation } from "../../state/presentation";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useAssistantStatus } from "../sidebar/useSidebarZones";
import { openAssistantDialog } from "./assistantDialogState";
import { assistantWorkAtom } from "./assistantWorkState";
import { AssistantSchedules } from "./AssistantSchedules";
import { AssistantWorkLibrary } from "./AssistantWorkLibrary";
import { AssistantWorkMemory } from "./AssistantWorkMemory";

const TABS = [
  { id: "routines", label: "Routines" },
  { id: "memory", label: "Memory" },
  { id: "library", label: "Library" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function AssistantWorkHost() {
  const target = useAtomValue(assistantWorkAtom);
  const { active } = useAssistantEntries();
  const entry =
    target === null
      ? undefined
      : active.find(
          (candidate) =>
            candidate.environmentId === target.environmentId &&
            candidate.assistant.id === target.assistantId,
        );
  if (entry === undefined) return null;
  return (
    <AssistantWorkDialog
      key={`${entry.environmentId}:${entry.assistant.id}`}
      environmentId={entry.environmentId as EnvironmentId}
      assistant={entry.assistant}
      onClose={() => appAtomRegistry.set(assistantWorkAtom, null)}
    />
  );
}

function fail(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Whether the assistant can work now, what it has queued up, remembers and handed over. */
function AssistantWorkDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly onClose: () => void;
}) {
  const { environmentId, assistant, onClose } = props;
  const [tab, setTab] = useState<TabId>("routines");
  const nowMs = useNowMinuteMs();
  const reachable = environmentReachable(
    useEnvironmentPresentation(environmentId).presentation?.connection,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{assistant.name} work</DialogTitle>
          <DialogDescription>
            Whether it can work now, and what it runs, remembers and has handed over.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <AssistantStatusCard
              environmentId={environmentId}
              assistant={assistant}
              reachable={reachable}
              onNavigate={onClose}
            />
            {/* Routines, Memory and Library come from its server, which cannot answer now. */}
            {reachable === false ? null : (
              <>
                <ToggleGroup
                  aria-label="Work sections"
                  className="w-full *:flex-1"
                  value={[tab]}
                  onValueChange={(next) => {
                    const value = TABS.find((candidate) => candidate.id === next[0]);
                    if (value !== undefined) setTab(value.id);
                  }}
                >
                  {TABS.map((candidate) => (
                    <Toggle key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                {tab === "routines" ? (
                  assistant.threadId === null ? (
                    <p className="text-xs text-muted-foreground">
                      Its conversation is not ready yet.
                    </p>
                  ) : (
                    <AssistantSchedules
                      environmentId={environmentId}
                      threadId={assistant.threadId}
                      onNavigate={onClose}
                    />
                  )
                ) : tab === "memory" ? (
                  <AssistantWorkMemory
                    environmentId={environmentId}
                    assistant={assistant}
                    onNavigate={onClose}
                  />
                ) : (
                  <AssistantWorkLibrary
                    environmentId={environmentId}
                    assistant={assistant}
                    nowMs={nowMs}
                  />
                )}
              </>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

const HEADLINE_ICON: Record<AssistantWorkHeadline["kind"], readonly [LucideIcon, string]> = {
  offline: [WifiOffIcon, "text-muted-foreground"],
  needs: [MessageCircleQuestionIcon, "text-warning-foreground"],
  blocked: [AlertTriangleIcon, "text-destructive-foreground"],
  limited: [AlertTriangleIcon, "text-warning-foreground"],
  working: [CircleEllipsisIcon, "text-info-foreground"],
  failed: [CircleXIcon, "text-destructive-foreground"],
  ready: [CheckCircle2Icon, "text-success-foreground"],
};

function AssistantStatusCard(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly reachable: boolean | null;
  readonly onNavigate: () => void;
}) {
  const { environmentId, assistant } = props;
  const navigate = useNavigate();
  const projects = useProjects();
  const shell = useThreadShell(
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId),
  );
  const providers = useEnvironmentProviders().get(environmentId) ?? null;
  const sandbox = useAssistantSandbox(assistant.workspace === "sandbox" ? environmentId : null);
  const sandboxActions = useAssistantSandboxActions(environmentId);
  const autonomy = useEnvironmentSettings(environmentId, (settings) => settings.autonomy);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [retrying, setRetrying] = useState(false);

  const status = assistantWorkStatus({
    assistant,
    projectFound: projects.some(
      (project) => project.environmentId === environmentId && project.id === assistant.projectId,
    ),
    modelSelection: shell?.modelSelection ?? null,
    providers,
    sandbox,
    autonomyEnabled: autonomy.enabled,
  });
  const headline = assistantWorkHeadline(
    status,
    useAssistantStatus().of(environmentId, assistant),
    props.reachable,
  );
  const [HeadlineIcon, headlineTone] = HEADLINE_ICON[headline.kind];
  const retry = headline.kind === "offline" ? null : assistantRetryPlan(shell);
  const fixable = headline.kind === "blocked" || headline.kind === "limited";

  const fix = async (kind: AssistantWorkFix) => {
    switch (kind) {
      case "providers":
        props.onNavigate();
        return void navigate({ to: "/settings/providers" });
      case "editAssistant":
        props.onNavigate();
        return openAssistantDialog({ environmentId, assistantId: assistant.id });
      case "resumeAutonomy":
        return void updateSettings({ autonomy: { ...autonomy, enabled: true } });
      case "startSandbox": {
        const reply = await sandboxActions.start();
        if (!reply.ok) fail("Could not start the sandbox", new Error(reply.message));
      }
    }
  };

  const retryRun = async () => {
    if (retry === null || shell === null || retrying) return;
    setRetrying(true);
    const result = await startTurn({
      environmentId,
      input: {
        threadId: shell.id,
        ...(retry.kind === "continue" ? { manualContinuationOfRunId: retry.runId } : {}),
        modelSelection: shell.modelSelection,
        message: {
          messageId: newMessageId(),
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
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      fail("Could not retry", squashAtomCommandFailure(result));
  };

  return (
    <section
      aria-label="Status"
      data-testid="assistant-status-card"
      className="flex flex-col gap-2.5 rounded-xl border border-foreground/12 p-3"
    >
      <div className="flex items-start gap-2.5">
        <HeadlineIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${headlineTone}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{headline.title}</span>
          {headline.detail === null ? null : (
            <p className="text-xs text-muted-foreground">{headline.detail}</p>
          )}
        </div>
        {!fixable || status.ok || status.fix === null ? null : (
          <Button size="xs" variant="outline" onClick={() => void fix(status.fix!.kind)}>
            {status.fix.label}
          </Button>
        )}
      </div>
      {retry === null ? null : (
        <div className="flex items-center gap-2.5 border-t border-foreground/12 pt-2.5">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {shell?.latestRun?.status === "failed"
              ? "Its last run failed."
              : "Its last run was stopped."}
          </p>
          <Button size="xs" variant="outline" disabled={retrying} onClick={() => void retryRun()}>
            <RotateCcwIcon />
            Retry
          </Button>
        </div>
      )}
    </section>
  );
}
