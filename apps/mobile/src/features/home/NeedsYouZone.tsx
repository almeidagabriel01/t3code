import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDecisionExpiry } from "@t3tools/client-runtime/state/decisions";
import {
  GUEST_WAITING_LABEL,
  needsYouCards,
  type NeedsYouDue,
} from "@t3tools/client-runtime/sidebarZones";
import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type Assistant,
  type Decision,
} from "@t3tools/contracts";
import { memo, useState, type ReactNode } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useAssistantEntries } from "../../state/assistants";
import { useDecisionActions } from "../../state/decisions";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AssistantAvatar } from "../assistants/assistantPresentation";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useSidebarZones } from "./useSidebarZones";

const SHOWN_LIMIT = 5;
const DECISION_OPTION_LIMIT = 3;
const QUESTION_OPTION_LIMIT = 4;

interface ItemOrigin {
  readonly environmentId: string;
  readonly threadId: string;
  readonly createdAt: string | null;
  /** The decision's deadline; null for a request or a guest. */
  readonly due: NeedsYouDue;
  /** The assistant whose work this is; null for a project thread. */
  readonly assistant: Assistant | null;
  /** Set when the thread is an assistant's thread in a group. */
  readonly teamName: string | null;
  /** The thread title a decision carries, for a thread this client has not loaded. */
  readonly threadTitle: string | null;
  readonly sidebar: boolean;
}

function useOpenThread(environmentId: string, threadId: string) {
  const selectDetail = useSelectWorkspaceDetail();
  // By id: an assistant's threads are never in a project list.
  return () => selectDetail({ name: "Thread", params: { environmentId, threadId } });
}

/** Two lines: who asks and where, then what. Actions and errors sit under them. */
function ItemFrame(
  props: ItemOrigin & {
    readonly icon: AppSymbolName;
    readonly summary: string;
    readonly actions: ReactNode;
    readonly error: string | null;
  },
) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, ThreadId.make(props.threadId)));
  const project = useProject(
    thread === null ? null : { environmentId, projectId: ProjectId.make(thread.projectId) },
  );
  const nowMs = useNowMinuteMs();
  const open = useOpenThread(props.environmentId, props.threadId);
  const strong = props.sidebar ? "text-drawer-foreground" : "text-foreground";
  const muted = props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const iconTint = props.sidebar ? "accent-drawer-foreground-muted" : "accent-icon-subtle";
  const origin =
    props.teamName ?? props.assistant?.name ?? thread?.title ?? props.threadTitle ?? "Thread";
  return (
    <View
      testID="needs-you-item"
      className={cn(
        "gap-1.5 rounded-2xl px-2 py-2",
        props.due?.soon === true && "border border-warning-border bg-warning",
      )}
    >
      <View className="min-h-6 flex-row items-center gap-2">
        {props.teamName !== null ? (
          <SymbolView
            name="bubble.left.and.bubble.right"
            size={14}
            tintColorClassName={iconTint}
            type="monochrome"
          />
        ) : props.assistant !== null ? (
          <AssistantAvatar assistant={props.assistant} environmentId={environmentId} size={20} />
        ) : project !== null ? (
          <ProjectFavicon
            environmentId={project.environmentId}
            faviconPath={project.faviconPath}
            projectIcon={project.projectIcon}
            size={16}
            projectTitle={project.title}
            workspaceRoot={project.workspaceRoot}
          />
        ) : null}
        <Text className={cn("shrink font-t3-medium text-sm", strong)} numberOfLines={1}>
          {origin}
        </Text>
        {project !== null ? (
          <Text className={cn("min-w-0 flex-1 text-xs", muted)} numberOfLines={1}>
            · {project.title}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {props.due !== null ? (
          <Text
            className={cn(
              "text-xs",
              props.due.soon ? "font-t3-medium text-warning-foreground" : muted,
            )}
          >
            {formatDecisionExpiry(props.due.at, nowMs)}
          </Text>
        ) : props.createdAt === null ? null : (
          <Text className={cn("text-xs", muted)}>{relativeTime(props.createdAt, nowMs)}</Text>
        )}
      </View>
      <View className="flex-row items-center gap-2">
        <SymbolView name={props.icon} size={13} tintColorClassName={iconTint} type="monochrome" />
        <Text className={cn("min-w-0 flex-1 text-sm", muted)} numberOfLines={1}>
          {props.summary}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        {props.actions}
        <Button label="Open" tone="text" size="compact" onPress={open} />
      </View>
      {props.error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

const failureMessage = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : fallback;
};

/** An approval or a question; its detail loads only while the item is drawn. */
const RequestItem = memo(function RequestItem(
  props: ItemOrigin & { readonly kind: "approval" | "question"; readonly requestId: string },
) {
  const environmentId = EnvironmentId.make(props.environmentId);
  const threadId = ThreadId.make(props.threadId);
  const pending = useAtomValue(
    environmentThreadDetails.pendingRequestsAtom(scopeThreadRef(environmentId, threadId)),
  );
  const canRespond = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const approval = pending?.approvals.find((entry) => entry.requestId === props.requestId) ?? null;
  const input = pending?.userInputs.find((entry) => entry.requestId === props.requestId) ?? null;
  const run = async (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy || !canRespond) return;
    setBusy(true);
    setError(null);
    const result = await send();
    setBusy(false);
    setError(failureMessage(result, "Could not send the answer."));
  };
  const off = busy || !canRespond;

  if (props.kind === "approval") {
    const live = approval !== null && approval.responseCapability === "live";
    const decide = (decision: "accept" | "decline") =>
      void run(() =>
        respondToApproval({
          environmentId,
          input: { threadId, requestId: approval!.requestId, decision },
        }),
      );
    return (
      <ItemFrame
        {...props}
        icon="exclamationmark.shield"
        summary={approval?.detail ?? approval?.reason ?? "Waiting for approval"}
        error={error}
        actions={
          live ? (
            <>
              <Button
                label="Approve"
                tone="primary"
                size="compact"
                disabled={off}
                onPress={() => decide("accept")}
              />
              <Button
                label="Deny"
                size="compact"
                disabled={off}
                onPress={() => decide("decline")}
              />
            </>
          ) : null
        }
      />
    );
  }

  // Several questions, or a request the provider can no longer take, are answered in the thread.
  const question =
    input !== null && input.responseCapability === "live" && input.questions.length === 1
      ? input.questions[0]!
      : null;
  const answer = (draft: { selectedOptionValues?: string[]; customAnswer?: string }) => {
    if (input === null || question === null) return;
    const answers = buildPendingUserInputAnswers([question], { [question.id]: draft });
    if (answers === null) return;
    void run(() =>
      respondToUserInput({
        environmentId,
        input: { threadId, requestId: input.requestId, answers },
      }),
    );
  };
  const optionButtons =
    question !== null &&
    !question.multiSelect &&
    question.options.length > 0 &&
    question.options.length <= QUESTION_OPTION_LIMIT;
  const typed = question !== null && !optionButtons && question.allowCustomAnswer !== false;
  const send = () => {
    if (text.trim() === "") return;
    Keyboard.dismiss();
    answer({ customAnswer: text });
  };
  return (
    <ItemFrame
      {...props}
      icon="questionmark.bubble"
      summary={input?.questions[0]?.question ?? "Asked a question"}
      error={error}
      actions={
        optionButtons ? (
          question.options.map((option) => (
            <Button
              key={option.label}
              label={option.label}
              size="compact"
              disabled={off}
              onPress={() => answer({ selectedOptionValues: [option.value ?? option.label] })}
            />
          ))
        ) : typed ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <TextInput
              accessibilityLabel="Answer"
              placeholder="Answer"
              value={text}
              editable={!off}
              onChangeText={setText}
              onSubmitEditing={send}
              returnKeyType="send"
              className="min-h-10 min-w-0 flex-1 rounded-2xl border border-input-border bg-input px-3 font-sans text-sm text-foreground"
            />
            <Button
              label="Send"
              tone="primary"
              size="compact"
              disabled={off || text.trim() === ""}
              onPress={send}
            />
          </View>
        ) : null
      }
    />
  );
});

const DecisionItem = memo(function DecisionItem(
  props: ItemOrigin & { readonly decision: Decision },
) {
  const actions = useDecisionActions(EnvironmentId.make(props.environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { decision } = props;
  const pick = async (optionId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const reply = await actions.answer(decision.id, { optionId });
    setBusy(false);
    if (!reply.ok) setError(reply.message);
  };
  return (
    <ItemFrame
      {...props}
      icon="arrow.triangle.branch"
      summary={decision.title}
      error={error}
      actions={
        decision.options.length <= DECISION_OPTION_LIMIT
          ? decision.options.map((option) => (
              <Button
                key={option.id}
                label={option.label}
                tone={decision.recommended === option.id ? "primary" : "secondary"}
                size="compact"
                disabled={busy || !actions.canAct}
                onPress={() => void pick(option.id)}
              />
            ))
          : null
      }
    />
  );
});

/** Guest messages wait in the thread, where the owner sends or dismisses them. */
const GuestItem = memo(function GuestItem(props: ItemOrigin) {
  return (
    <ItemFrame
      {...props}
      icon="person.badge.clock"
      summary={GUEST_WAITING_LABEL}
      error={null}
      actions={null}
    />
  );
});

/**
 * Everything that waits on the user, answerable in place: what expires within the hour first,
 * then oldest first (`needsYouCards`). Absent when empty.
 */
export function NeedsYouZone(props: { readonly gutter: number; readonly sidebar?: boolean }) {
  const { items: waits } = useSidebarZones();
  const { active, activeTeams } = useAssistantEntries();
  const [showAll, setShowAll] = useState(false);
  const nowMs = useNowMinuteMs();
  if (waits.length === 0) return null;
  const items = needsYouCards(waits, nowMs);
  const sidebar = props.sidebar === true;
  const assistantByKey = new Map(
    active.map((entry) => [`${entry.environmentId}:${entry.assistant.id}`, entry.assistant]),
  );
  const teamNameByKey = new Map(
    activeTeams.map((entry) => [`${entry.environmentId}:${entry.team.id}`, entry.team.name]),
  );
  const shown = showAll ? items : items.slice(0, SHOWN_LIMIT);
  const hidden = items.length - shown.length;
  const muted = sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary";
  return (
    <View className="pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      <View className="min-h-9 flex-row items-center gap-1.5">
        <Text className={cn("font-t3-bold text-2xs uppercase tracking-[1.1px]", muted)}>
          Needs you
        </Text>
        <Text className={cn("font-t3-bold text-2xs", muted)}>{items.length}</Text>
      </View>
      {shown.map((item) => {
        const origin: ItemOrigin = {
          environmentId: item.environmentId,
          threadId: item.threadId,
          createdAt: item.createdAt,
          due: item.due,
          threadTitle: item.kind === "decision" ? item.decision.threadTitle || null : null,
          assistant:
            item.owner.kind === "assistant"
              ? (assistantByKey.get(item.owner.assistantKey) ?? null)
              : null,
          teamName:
            item.owner.kind === "assistant" && item.owner.teamKey !== null
              ? (teamNameByKey.get(item.owner.teamKey) ?? null)
              : null,
          sidebar,
        };
        switch (item.kind) {
          case "decision":
            return <DecisionItem key={item.key} {...origin} decision={item.decision} />;
          case "guest":
            return <GuestItem key={item.key} {...origin} />;
          case "approval":
          case "question":
            return (
              <RequestItem
                key={item.key}
                {...origin}
                kind={item.kind}
                requestId={item.request.id}
              />
            );
          default:
            return item satisfies never;
        }
      })}
      {items.length > SHOWN_LIMIT ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll((value) => !value)}
          className="min-h-10 justify-center px-2 active:opacity-70"
        >
          <Text className={cn("text-xs font-t3-medium", muted)}>
            {showAll ? "Show less" : `Show ${hidden} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
