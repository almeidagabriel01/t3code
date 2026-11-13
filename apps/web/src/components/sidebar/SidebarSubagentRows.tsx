import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { startThreadDrag } from "../threadDrag";
import { resolveSubagentDisplay } from "./sidebarDisplay.logic";
import { WorkingDuration } from "./WorkingDuration";

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function subagentDotClass(thread: EnvironmentThreadShell): string {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "bg-amber-500 dark:bg-amber-300/90";
  if (status === "request") return "bg-guest";
  return "bg-sky-500 dark:bg-sky-300/80";
}

type SubagentContextMenu = (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;

function SubagentRow(props: {
  thread: EnvironmentThreadShell;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu?: SubagentContextMenu | undefined;
}) {
  const { thread, onContextMenu } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return (
    <li className="relative list-none">
      <span aria-hidden className="absolute inset-y-0 start-9 w-px bg-sidebar-border" />
      <button
        type="button"
        data-testid="sidebar-subagent-row"
        onClick={() => props.onOpen(threadRef)}
        onPointerDown={(event) => startThreadDrag(event.nativeEvent, threadRef, thread.title)}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-12 pe-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", subagentDotClass(thread))}
        />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="shrink-0 tabular-nums">
          <WorkingDuration startedAt={resolveThreadWorkingStartedAt(thread)} />
        </span>
      </button>
    </li>
  );
}

export function SubagentRows(props: {
  children: readonly EnvironmentThreadShell[];
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu?: SubagentContextMenu | undefined;
}) {
  const show = useClientSettings((settings) => settings.sidebarShowSubagents);
  const mode = useClientSettings((settings) => settings.sidebarAgentActivityDisplayMode);
  const [expanded, setExpanded] = useState(false);
  const display = resolveSubagentDisplay({
    count: props.children.length,
    show,
    mode,
    expanded,
  });
  if (display === "hidden") return null;
  return (
    <>
      {display === "summary" || display === "summary-and-rows" ? (
        <li className="list-none">
          <button
            type="button"
            aria-expanded={expanded}
            data-testid="sidebar-subagent-summary"
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-12 pe-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", subagentDotClass(props.children[0]!))}
            />
            <span className="min-w-0 flex-1 truncate">{`${props.children.length} agents`}</span>
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0", !expanded && "-rotate-90")}
            />
          </button>
        </li>
      ) : null}
      {display === "rows" || display === "summary-and-rows"
        ? props.children.map((child) => (
            <SubagentRow
              key={threadKeyOf(child)}
              thread={child}
              onOpen={props.onOpen}
              onContextMenu={props.onContextMenu}
            />
          ))
        : null}
    </>
  );
}
