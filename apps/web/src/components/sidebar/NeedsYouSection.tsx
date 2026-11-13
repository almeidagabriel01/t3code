import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { NeedsYouItem } from "@t3tools/client-runtime/sidebarZones";
import { buildPendingUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type Decision,
  type EnvironmentId,
  type ProjectId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { HashIcon, MessageCircleQuestionIcon, ShieldAlertIcon, SignpostIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import type { AssistantEntry } from "../../state/assistants";
import { useDecisionActions } from "../../state/decisions";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AssistantAvatar } from "../assistants/assistantPresentation";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Item = NeedsYouItem<Decision>;
type Project = ProjectFaviconProject & { readonly title: string };

const VISIBLE_ITEMS = 5;
const MAX_OPTION_BUTTONS = 4;
const MAX_DECISION_BUTTONS = 3;

const failureText = (
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message !== "" ? failure.message : fallback;
};

/** One answer at a time per card; a failure stays on the card in words. */
function useAnswer() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (send: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failed = await send();
    setError(failed);
    setBusy(false);
  };
  return { busy, error, run };
}

function CardShell(props: {
  readonly item: Item;
  readonly origin: ReactNode;
  readonly projectName: string | null;
  readonly kindIcon: ReactNode;
  readonly summary: string;
  readonly actions: ReactNode;
  readonly error: string | null;
}) {
  const nowMs = useNowMinuteMs();
  return (
    <li className="list-none px-1 py-0.5" data-testid="needs-you-item" data-kind={props.item.kind}>
      <div className="rounded-lg border border-foreground/10 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {props.origin}
          {props.projectName === null ? null : (
            <span className="min-w-0 shrink-[10] truncate text-muted-foreground">
              · {props.projectName}
            </span>
          )}
          <span className="ms-auto shrink-0 ps-1 text-muted-foreground tabular-nums">
            {formatRelativeTimeLabel(props.item.createdAt, nowMs)}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {props.kindIcon}
          <span className="min-w-0 truncate" data-testid="needs-you-summary">
            {props.summary}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">{props.actions}</div>
        {props.error === null ? null : (
          <p role="alert" className="mt-1 text-xs text-destructive-foreground">
            {props.error}
          </p>
        )}
      </div>
    </li>
  );
}

function OpenButton(props: { readonly onOpen: () => void }) {
  return (
    <Button size="micro" variant="ghost-muted" onClick={props.onOpen}>
      Open
    </Button>
  );
}

interface CardProps {
  readonly item: Item;
  readonly origin: ReactNode;
  readonly projectName: string | null;
  readonly onOpen: () => void;
}

/** An approval or a question: reads the thread's pending requests, so only drawn cards subscribe. */
function RequestCard(props: CardProps & { readonly threadRef: ScopedThreadRef }) {
  const { item, threadRef } = props;
  const requestId = item.request!.id as RuntimeRequestId;
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const answer = useAnswer();
  const [text, setText] = useState("");
  const open = <OpenButton onOpen={props.onOpen} />;

  if (item.kind === "approval") {
    const approval = requests?.approvals.find((candidate) => candidate.requestId === requestId);
    const respond = (decision: ProviderApprovalDecision) =>
      answer.run(async () =>
        failureText(
          await respondToApproval({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, requestId, decision },
          }),
          "Failed to submit approval decision.",
        ),
      );
    const answerable =
      approval !== undefined && approval.responseCapability === "live" && canOperate;
    return (
      <CardShell
        {...props}
        kindIcon={<ShieldAlertIcon aria-hidden className="size-3.5 shrink-0" />}
        summary={approval?.detail || approval?.reason || "Waiting for approval"}
        error={answer.error}
        actions={
          <>
            {answerable ? (
              <>
                <Button
                  size="micro"
                  variant="default"
                  disabled={answer.busy}
                  onClick={() => void respond("accept")}
                >
                  Approve
                </Button>
                <Button
                  size="micro"
                  variant="outline"
                  disabled={answer.busy}
                  onClick={() => void respond("decline")}
                >
                  Deny
                </Button>
              </>
            ) : null}
            {open}
          </>
        }
      />
    );
  }

  const input = requests?.userInputs.find((candidate) => candidate.requestId === requestId);
  const question =
    input !== undefined &&
    input.questions.length === 1 &&
    input.responseCapability === "live" &&
    input.responseMode === undefined &&
    canOperate
      ? input.questions[0]!
      : null;
  const send = (draft: { selectedOptionValues: string[] } | { customAnswer: string }) => {
    if (question === null) return;
    const answers = buildPendingUserInputAnswers([question], { [question.id]: draft });
    if (answers === null) return;
    void answer.run(async () =>
      failureText(
        await respondToUserInput({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, requestId, answers },
        }),
        "Failed to submit the answer.",
      ),
    );
  };
  const optionButtons =
    question !== null &&
    !question.multiSelect &&
    question.options.length > 0 &&
    question.options.length <= MAX_OPTION_BUTTONS;
  const freeText = question !== null && !optionButtons && question.allowCustomAnswer !== false;
  return (
    <CardShell
      {...props}
      kindIcon={<MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0" />}
      summary={input?.questions[0]?.question ?? "Asked a question"}
      error={answer.error}
      actions={
        <>
          {optionButtons
            ? question.options.map((option) => (
                <Button
                  key={option.value ?? option.label}
                  size="micro"
                  variant="outline"
                  disabled={answer.busy}
                  onClick={() => send({ selectedOptionValues: [option.value ?? option.label] })}
                >
                  {option.label}
                </Button>
              ))
            : null}
          {freeText ? (
            <form
              className="flex w-full items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim() !== "") send({ customAnswer: text });
              }}
            >
              <Input
                size="compact"
                aria-label={`Answer: ${question.question}`}
                value={text}
                disabled={answer.busy}
                onChange={(event) => setText(event.currentTarget.value)}
              />
              <Button
                type="submit"
                size="micro"
                variant="default"
                disabled={answer.busy || text.trim() === ""}
              >
                Send
              </Button>
            </form>
          ) : null}
          {open}
        </>
      }
    />
  );
}

function DecisionCard(props: CardProps & { readonly decision: Decision }) {
  const { decision } = props;
  const actions = useDecisionActions(props.item.environmentId as never);
  const answer = useAnswer();
  return (
    <CardShell
      {...props}
      kindIcon={<SignpostIcon aria-hidden className="size-3.5 shrink-0" />}
      summary={decision.title}
      error={answer.error}
      actions={
        <>
          {actions.canAct
            ? decision.options.slice(0, MAX_DECISION_BUTTONS).map((option) => (
                <Button
                  key={option.id}
                  size="micro"
                  variant={option.id === decision.recommended ? "default" : "outline"}
                  disabled={answer.busy}
                  onClick={() =>
                    void answer.run(async () => {
                      const reply = await actions.answer(decision.id, { optionId: option.id });
                      return reply.ok ? null : reply.message;
                    })
                  }
                >
                  {option.label}
                </Button>
              ))
            : null}
          <OpenButton onOpen={props.onOpen} />
        </>
      }
    />
  );
}

const NeedsYouCard = memo(function NeedsYouCard(props: {
  readonly item: Item;
  readonly assistant: AssistantEntry | null;
  readonly teamName: string | null;
  readonly projectOf: (environmentId: EnvironmentId, projectId: ProjectId) => Project | undefined;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { item } = props;
  const threadRef = scopeThreadRef(item.environmentId as never, item.threadId as never);
  const shell = useQuietThreadShell(threadRef);
  const project =
    shell === null ? undefined : props.projectOf(threadRef.environmentId, shell.projectId);
  const title = shell?.title ?? (item.decision?.threadTitle || "Thread");
  const origin =
    props.teamName !== null ? (
      <span className="flex min-w-0 shrink items-center gap-1 font-medium">
        <HashIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{props.teamName}</span>
      </span>
    ) : props.assistant !== null ? (
      <span className="flex min-w-0 shrink items-center gap-1 font-medium">
        <AssistantAvatar assistant={props.assistant.assistant} className="size-4 shrink-0" />
        <span className="truncate">{props.assistant.assistant.name}</span>
      </span>
    ) : (
      <span className="flex min-w-0 shrink items-center gap-1 font-medium">
        {project === undefined ? null : (
          <ProjectFavicon project={project} className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{title}</span>
      </span>
    );
  const card: CardProps = {
    item,
    origin,
    projectName: project?.title ?? null,
    onOpen: () => props.onOpenThread(threadRef),
  };
  return item.decision !== null ? (
    <DecisionCard {...card} decision={item.decision} />
  ) : (
    <RequestCard {...card} threadRef={threadRef} />
  );
});

/** Everything waiting on the user, oldest first, answerable in place. Absent while nothing waits. */
export const NeedsYouSection = memo(function NeedsYouSection(props: {
  readonly items: ReadonlyArray<Item>;
  readonly assistantByKey: ReadonlyMap<string, AssistantEntry>;
  readonly teamNameByKey: ReadonlyMap<string, string>;
  readonly projectOf: (environmentId: EnvironmentId, projectId: ProjectId) => Project | undefined;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (props.items.length === 0) return null;
  const shown = showAll ? props.items : props.items.slice(0, VISIBLE_ITEMS);
  const more = props.items.length - shown.length;
  return (
    <>
      <li
        data-testid="sidebar-needs-you-header"
        className="flex list-none items-center gap-1 px-(--sidebar-row-content-inset) pt-3 pb-1 text-xs font-medium text-secondary-label"
      >
        Needs you
        <span className="font-normal text-muted-foreground tabular-nums">{props.items.length}</span>
      </li>
      {shown.map((item) => (
        <NeedsYouCard
          key={item.key}
          item={item}
          assistant={
            item.owner.kind === "assistant"
              ? (props.assistantByKey.get(item.owner.assistantKey) ?? null)
              : null
          }
          teamName={
            item.owner.kind === "assistant" && item.owner.teamKey !== null
              ? (props.teamNameByKey.get(item.owner.teamKey) ?? null)
              : null
          }
          projectOf={props.projectOf}
          onOpenThread={props.onOpenThread}
        />
      ))}
      {more > 0 || showAll ? (
        <li className="list-none px-1">
          <Button size="micro" variant="ghost-muted" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show less" : `Show ${more} more`}
          </Button>
        </li>
      ) : null}
    </>
  );
});
