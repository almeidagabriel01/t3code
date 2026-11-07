import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { assistantPresence } from "@t3tools/client-runtime/assistantRobot";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { type AssistantEntry, useAssistantEntries } from "../../state/assistants";
import { useThreadShell } from "../../state/entities";
import { AssistantAvatar } from "./assistantPresentation";

const MOOD_TEXT = {
  idle: "text-muted-foreground",
  working: "text-info-foreground",
  needs: "text-warning-foreground",
  failed: "text-destructive-foreground",
} as const;

const ProjectAssistantRow = memo(function ProjectAssistantRow(props: {
  readonly entry: AssistantEntry;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { assistant, environmentId } = props.entry;
  const threadRef =
    assistant.threadId === null ? null : scopeThreadRef(environmentId, assistant.threadId);
  const presence = assistantPresence(useThreadShell(threadRef));
  return (
    <li className="list-none">
      <button
        type="button"
        data-testid="project-assistant-row"
        aria-label={`${assistant.name}, ${presence.detail}`}
        aria-current={props.isActive ? "page" : undefined}
        disabled={threadRef === null}
        onClick={() => threadRef !== null && props.onOpen(threadRef)}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-(--sidebar-row-content-inset) text-left text-sm text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
          props.isActive && "bg-sidebar-row-active",
        )}
      >
        <AssistantAvatar assistant={assistant} mood={presence.mood} className="size-4.5" />
        <span className="min-w-0 truncate font-medium">{assistant.name}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs", MOOD_TEXT[presence.mood])}>
          {presence.detail}
        </span>
      </button>
    </li>
  );
});

/** The project's own assistants, above its threads. Their `assistant:` threads never list as rows. */
export function ProjectAssistantRows(props: {
  readonly members: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
  readonly routeThreadKey: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { active } = useAssistantEntries();
  const entries = active.filter(
    ({ environmentId, assistant }) =>
      assistant.scope === "project" &&
      props.members.some(
        (member) => member.environmentId === environmentId && member.id === assistant.projectId,
      ),
  );
  return entries.map((entry) => (
    <ProjectAssistantRow
      key={`${entry.environmentId}:${entry.assistant.id}`}
      entry={entry}
      isActive={
        entry.assistant.threadId !== null &&
        scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId)) ===
          props.routeThreadKey
      }
      onOpen={props.onOpen}
    />
  ));
}
