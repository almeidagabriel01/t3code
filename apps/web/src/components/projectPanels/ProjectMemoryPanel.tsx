import {
  memoryBrowseInput,
  memoryPreview,
  memoryRuleText,
  memorySearchInput,
} from "@t3tools/client-runtime/memory-browsing";
import {
  AuthMemoryReadScope,
  isMemoryRule,
  MEMORY_PAGE_MAX_ITEMS,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
  type ProjectId,
} from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { PencilIcon, SearchIcon, Settings2Icon, XIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { RightPanelLoading, RightPanelMessage } from "../chat/RightPanelStates";
import {
  useMemorySpace,
  useProjectMemoryScope,
  type ProjectMemoryScope,
} from "../memory/useProjectMemoryScope";
import { RelativeTime } from "../RelativeTime";
import { validateMemorySettingsSearch } from "../settings/MemorySettings.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectPanelFrame } from "./ProjectPanelFrame";

const MemoryEditor = lazy(() =>
  import("../settings/MemorySettings").then((module) => ({ default: module.MemoryEditor })),
);
const MemoryForgetControl = lazy(() =>
  import("../settings/MemorySettings").then((module) => ({ default: module.MemoryForgetControl })),
);

type ActiveMemory = Extract<MemoryItem, { status: "active" }>;

const SCOPE_MESSAGE: Record<
  Exclude<ProjectMemoryScope["status"], "ready" | "loading">,
  { readonly title: string; readonly detail: string; readonly alert?: true }
> = {
  "no-permission": {
    title: "Memory write access needed",
    detail: "Finding this project's memories needs memory write permission on this server.",
  },
  "no-key": {
    title: "This project has no shared memory",
    detail: "Give it a repository or a shared memory key in Settings, Memory.",
  },
  failed: {
    title: "Could not load this project's memory",
    detail: "Close and reopen this tab to try again.",
    alert: true,
  },
};

/** The project's memories: search them, edit one in place, or forget it after a confirmation. */
export function ProjectMemoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const canRead = useEnvironmentScope(environmentId, AuthMemoryReadScope);
  const space = useMemorySpace(environmentId, canRead);
  const scope = useProjectMemoryScope(environmentId, props.projectId, space);
  const [queryInput, setQueryInput] = useState("");
  const [query] = useDebouncedValue(queryInput.trim(), { wait: 250 });

  const body = !canRead ? (
    <RightPanelMessage
      title="Memory read access needed"
      detail="This connection cannot read memory on this server."
    />
  ) : space === null ? (
    <RightPanelMessage
      title="Memory is not ready"
      detail="Memory is off or still getting ready on this server."
    />
  ) : scope === null || scope.status === "loading" ? (
    <RightPanelLoading label="Loading project memory…" />
  ) : scope.status !== "ready" ? (
    <RightPanelMessage {...SCOPE_MESSAGE[scope.status]} />
  ) : (
    <MemoryPages
      key={`${scope.status}:${query}`}
      environmentId={environmentId}
      memorySpaceId={space}
      scope={scope.scope}
      query={query}
    />
  );

  return (
    <ProjectPanelFrame
      title="Memory"
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Memory settings"
                onClick={() =>
                  void navigate({
                    to: "/settings/memory",
                    search: validateMemorySettingsSearch({ environmentId }),
                    hash: "",
                  })
                }
              />
            }
          >
            <Settings2Icon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Memory settings</TooltipPopup>
        </Tooltip>
      }
      toolbar={
        <div
          className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5"
          data-glass-layer
        >
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              size="sm"
              value={queryInput}
              onChange={(event) => setQueryInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && queryInput) {
                  event.preventDefault();
                  setQueryInput("");
                }
              }}
              placeholder="Search memories"
              aria-label="Search project memories"
              disabled={scope?.status !== "ready" || space === null}
            />
          </InputGroup>
          {queryInput === "" ? null : (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Clear search"
              onClick={() => setQueryInput("")}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </div>
      }
    >
      {body}
    </ProjectPanelFrame>
  );
}

function MemoryPages(props: {
  readonly environmentId: EnvironmentId;
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope;
  readonly query: string;
}) {
  const { environmentId, memorySpaceId, query } = props;
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const input = memoryBrowseInput({
    memorySpaceId,
    scope: props.scope,
    limit: MEMORY_PAGE_MAX_ITEMS,
    ...(cursor ? { cursor } : {}),
  });
  const page = useEnvironmentQuery(
    query
      ? memoryEnvironment.search({ environmentId, input: memorySearchInput(input, query) })
      : memoryEnvironment.list({ environmentId, input: { ...input, includeQuarantined: false } }),
  );
  const value = page.data ? Option.getOrNull(page.data) : null;
  if (page.error !== null) {
    return (
      <RightPanelMessage
        title="Could not load memories"
        detail="Check the connection to this server, then reopen the tab."
        alert
      />
    );
  }
  if (value === null) return <RightPanelLoading label="Loading memories…" />;
  const items = value.items.filter((item): item is ActiveMemory => item.status === "active");
  return (
    <>
      {items.length === 0 ? (
        <RightPanelMessage
          title={query ? "No matching memories" : "No memories yet"}
          detail={
            query
              ? "Try other words."
              : "What agents learn about this project shows here, ready to edit or forget."
          }
        />
      ) : (
        <ul aria-label="Project memories" className="flex flex-col">
          {items.map((item) => (
            <MemoryRow key={item.memoryId} environmentId={environmentId} item={item} />
          ))}
        </ul>
      )}
      {cursors.length === 0 && !value.nextCursor ? null : (
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Newer
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!value.nextCursor}
            onClick={() => {
              const next = value.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            Older
          </Button>
        </div>
      )}
    </>
  );
}

function MemoryRow(props: { readonly environmentId: EnvironmentId; readonly item: ActiveMemory }) {
  const { environmentId, item } = props;
  const [editing, setEditing] = useState(false);
  const rule = isMemoryRule(item.payload.text);
  const text = rule ? memoryRuleText(item) : item.payload.text;
  return (
    <li className="flex flex-wrap items-start gap-x-1 gap-y-1.5 rounded-md px-2 py-1.5 hover:bg-foreground/8 has-focus-visible:bg-foreground/8">
      {editing ? (
        <div className="basis-full text-xs">
          <Suspense fallback={null}>
            <MemoryEditor
              environmentId={environmentId}
              memorySpaceId={item.memorySpaceId}
              item={item}
              scope={item.scope}
              scopeLabel="This project"
              onClose={() => setEditing(false)}
            />
          </Suspense>
        </div>
      ) : (
        <>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="line-clamp-3 text-xs font-medium break-words text-foreground/90">
              {memoryPreview(text)}
            </p>
            <span className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
              {rule ? (
                <Badge size="sm" variant="info">
                  Rule
                </Badge>
              ) : null}
              {item.pendingSync ? (
                <Badge size="sm" variant="secondary">
                  Not synced
                </Badge>
              ) : null}
              <span className="truncate tabular-nums">
                <RelativeTime timestamp={item.revision.createdAtUtc} />
              </span>
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Edit memory"
                  onClick={() => setEditing(true)}
                />
              }
            >
              <PencilIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>Edit</TooltipPopup>
          </Tooltip>
          <Suspense fallback={null}>
            <MemoryForgetControl environmentId={environmentId} item={item} compact />
          </Suspense>
        </>
      )}
    </li>
  );
}
