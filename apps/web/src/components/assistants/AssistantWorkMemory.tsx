import {
  memoryBrowseInput,
  memoryPreview,
  memoryScopeLabel,
} from "@t3tools/client-runtime/memory-browsing";
import {
  assistantMemories,
  memorySourceLabel,
  type AssistantMemory,
} from "@t3tools/client-runtime/assistantWork";
import {
  AuthMemoryReadScope,
  MEMORY_PAGE_MAX_ITEMS,
  type Assistant,
  type EnvironmentId,
  type MemoryScope,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { PencilIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { memoryEnvironment } from "../../state/memory";
import { useMemorySpace, useProjectMemoryScope } from "../memory/useProjectMemoryScope";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useProjects, useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const MemoryEditor = lazy(() =>
  import("../settings/MemorySettings").then((module) => ({ default: module.MemoryEditor })),
);
const MemoryForgetControl = lazy(() =>
  import("../settings/MemorySettings").then((module) => ({ default: module.MemoryForgetControl })),
);

const NO_ITEMS: ReadonlyArray<never> = [];

/** What the assistant's conversations taught the memory, each with its source, to edit or forget. */
export function AssistantWorkMemory(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly onNavigate: () => void;
}) {
  const { environmentId, assistant } = props;
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const space = useMemorySpace(environmentId, canRead);
  const projectMemory = useProjectMemoryScope(
    environmentId,
    assistant.scope === "project" ? assistant.projectId : null,
    space,
  );
  const projectScope = projectMemory?.status === "ready" ? projectMemory.scope : null;
  const list = (scope: MemoryScope | null) =>
    space === null || scope === null
      ? null
      : memoryEnvironment.list({
          environmentId,
          input: {
            ...memoryBrowseInput({ memorySpaceId: space, scope, limit: MEMORY_PAGE_MAX_ITEMS }),
            includeQuarantined: false,
          },
        });
  const user = useEnvironmentQuery(list({ kind: "user" }));
  const project = useEnvironmentQuery(list(projectScope));
  const thread = useEnvironmentQuery(
    list(
      assistant.threadId === null
        ? null
        : { kind: "thread", thread: { environmentId, threadId: assistant.threadId } },
    ),
  );
  const itemsOf = (query: typeof user) =>
    (query.data ? Option.getOrNull(query.data)?.items : null) ?? NO_ITEMS;
  const memories = assistantMemories(
    [...itemsOf(thread), ...itemsOf(project), ...itemsOf(user)],
    assistant.id,
    environmentId,
    new Set(assistant.threadId === null ? [] : [assistant.threadId]),
  );
  const failed = [user, project, thread].some((query) => query.error !== null);

  if (!canRead) {
    return <Note>Memory read permission is required to see what it remembers.</Note>;
  }
  if (space === null) {
    return <Note>Memory is off or still getting ready on this server.</Note>;
  }
  return (
    <div className="flex flex-col gap-2">
      {failed ? <Note tone="error">Some memories could not be loaded.</Note> : null}
      {memories.length === 0 && !failed ? (
        <Note>Nothing remembered from its conversations yet.</Note>
      ) : (
        <AssistantMemoryList
          environmentId={environmentId}
          assistant={assistant}
          memories={memories}
          onNavigate={props.onNavigate}
        />
      )}
    </div>
  );
}

/** One row per memory: its text, scope, source conversation, and Edit and Forget. */
export function AssistantMemoryList(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Pick<Assistant, "projectId">;
  readonly memories: ReadonlyArray<AssistantMemory>;
  readonly onNavigate: () => void;
}) {
  const { environmentId } = props;
  const projects = useProjects();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {props.memories.map(({ item, sourceThreadId }) => {
        const scopeLabel =
          item.scope.kind === "project"
            ? (projects.find(
                (candidate) =>
                  candidate.environmentId === environmentId &&
                  candidate.id === props.assistant.projectId,
              )?.title ?? "Project")
            : memoryScopeLabel(item.scope);
        return (
          <li
            key={item.memoryId}
            data-testid="assistant-memory"
            className="flex flex-col gap-1.5 rounded-lg border border-foreground/12 p-2.5"
          >
            {editing === item.memoryId ? (
              <Suspense fallback={null}>
                <MemoryEditor
                  environmentId={environmentId}
                  memorySpaceId={item.memorySpaceId}
                  item={item}
                  scope={item.scope}
                  scopeLabel={scopeLabel}
                  onClose={() => setEditing(null)}
                />
              </Suspense>
            ) : (
              <p className="text-sm break-words whitespace-pre-wrap">
                {memoryPreview(item.payload.text)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" size="sm">
                {scopeLabel}
              </Badge>
              {sourceThreadId === null ? null : (
                <SourceLink
                  environmentId={environmentId}
                  threadId={sourceThreadId}
                  onNavigate={props.onNavigate}
                />
              )}
              <span className="ms-auto flex items-center gap-1">
                {editing === item.memoryId ? null : (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label="Edit memory"
                    onClick={() => setEditing(item.memoryId)}
                  >
                    <PencilIcon />
                    Edit
                  </Button>
                )}
                <Suspense fallback={null}>
                  <MemoryForgetControl environmentId={environmentId} item={item} label="Forget" />
                </Suspense>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SourceLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onNavigate: () => void;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const title = useThreadShell(ref)?.title;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      onClick={props.onNavigate}
      className="max-w-full cursor-pointer truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {memorySourceLabel(title)}
    </Link>
  );
}

function Note(props: { readonly children: string; readonly tone?: "error" }) {
  return (
    <p
      className={
        props.tone === "error"
          ? "text-xs text-destructive-foreground"
          : "rounded-md px-2 py-1.5 text-xs text-muted-foreground"
      }
    >
      {props.children}
    </p>
  );
}
