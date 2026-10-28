import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckCheckIcon, ChevronDownIcon } from "lucide-react";
import { SortableContext, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  resolveSidebarNotificationDotClass,
  resolveThreadLastVisitedAt,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
  sidebarListItemId,
  type SidebarListItem,
  type SidebarSection,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { useUiStateStore } from "../../uiStateStore";
import { useClientSettings } from "../../hooks/useSettings";
import { countLivePortsByProject, resolveSubagentDisplay } from "./sidebarDisplay.logic";
import { useListeningPorts } from "../statusBar/useListeningPorts";
import { SidebarMenuSub, SidebarMenuSubButton } from "../ui/sidebar";
import { SidebarNotificationDot } from "./SidebarNotificationDot";
import { SidebarProjectNewThreadButton } from "./SidebarProjectNewThreadButton";
import { SidebarProjectHoverCard } from "./SidebarProjectHoverCard";
import type { useSidebarProjectLayout } from "./useSidebarProjectLayout";
import {
  SIDEBAR_SORTABLE_DRAG_DISABLED,
  SIDEBAR_SORTABLE_DRAG_ENABLED,
  WorkingDuration,
} from "./SidebarThreadRow";
import {
  SidebarDragBoundary,
  SidebarSectionPlaceholder,
  SortableSidebarMarker,
} from "./SidebarListMarkers";
import { projectDragId } from "./sidebarProjectGroups.logic";

type ProjectLayout = ReturnType<typeof useSidebarProjectLayout>["layout"][number];

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function ProjectNotificationDot(props: { threads: readonly EnvironmentThreadShell[] }) {
  const dotClass = useUiStateStore((state) => {
    for (const thread of props.threads) {
      const dot = resolveSidebarNotificationDotClass({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          state.threadLastVisitedAtById[threadKeyOf(thread)],
        ),
      });
      if (dot !== null) return dot;
    }
    return null;
  });
  return <SidebarNotificationDot dotClass={dotClass} />;
}

function subagentDotClass(thread: EnvironmentThreadShell): string {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "bg-amber-500 dark:bg-amber-300/90";
  if (status === "request") return "bg-guest";
  return "bg-sky-500 dark:bg-sky-300/80";
}

function SubagentRow(props: {
  thread: EnvironmentThreadShell;
  onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  return (
    <li className="list-none">
      <button
        type="button"
        data-testid="sidebar-subagent-row"
        onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-8 pe-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", subagentDotClass(thread))}
        />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        <span className="shrink-0 tabular-nums">
          <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
        </span>
      </button>
    </li>
  );
}

function SubagentRows(props: {
  children: readonly EnvironmentThreadShell[];
  onOpen: (threadRef: ScopedThreadRef) => void;
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
            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-8 pe-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
            <SubagentRow key={threadKeyOf(child)} thread={child} onOpen={props.onOpen} />
          ))
        : null}
    </>
  );
}

export type SidebarProjectDrag = {
  readonly projectKey: string;
  /** The dragged thread's section, null while the drag leaves the list. */
  readonly from: SidebarSection | null;
  readonly targetSection: SidebarSection | null;
};

const idleSortingStrategy: SortingStrategy = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1 });

type ProjectGroupProps = {
  entry: ProjectLayout;
  items: readonly SidebarListItem[];
  portCounts: ReadonlyMap<string, number>;
  first: boolean;
  drag: SidebarProjectDrag | null;
  dragSortingStrategy: SortingStrategy;
  threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  subagentChildrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>;
  renderThreadRow: (thread: EnvironmentThreadShell, section: SidebarSection) => ReactNode;
  onToggleProject: (project: ProjectLayout["project"], expanded: boolean) => void;
  onToggleSettled: (projectKey: string) => void;
  onShowMoreSettled: (projectKey: string) => void;
  onOpenSubagent: (threadRef: ScopedThreadRef) => void;
  onListAttach: (projectKey: string, node: HTMLUListElement) => () => void;
  projectDragEnabled: boolean;
};

function SidebarProjectGroup(props: ProjectGroupProps) {
  const { entry, items } = props;
  const { project, group, expanded } = entry;
  const scope = project.projectKey;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: projectDragId(scope),
    disabled: props.projectDragEnabled
      ? SIDEBAR_SORTABLE_DRAG_ENABLED
      : SIDEBAR_SORTABLE_DRAG_DISABLED,
  });
  const { onListAttach } = props;
  const attachList = (node: HTMLUListElement) => onListAttach(scope, node);
  const drag = props.drag?.projectKey === scope ? props.drag : null;
  const from = drag?.from ?? null;
  const dragTargetSection = drag?.targetSection ?? null;
  const openCount = (section: SidebarSection) =>
    items.filter((item) => item.kind === "thread" && item.section === section).length;
  const renderRow = (key: string, section: SidebarSection) => {
    const thread = props.threadByKey.get(key);
    if (thread === undefined) return [];
    return [
      props.renderThreadRow(thread, section),
      <SubagentRows key={`${key}:subagents`} onOpen={props.onOpenSubagent}>
        {props.subagentChildrenByParent.get(key) ?? []}
      </SubagentRows>,
    ];
  };
  const renderItem = (item: SidebarListItem): ReactNode => {
    if (item.kind === "thread") return renderRow(item.key, item.section);
    const markerKey = `${scope}:${item.marker}`;
    switch (item.marker) {
      case "pinned-header":
        return (
          <SidebarDragBoundary
            key={markerKey}
            scope={scope}
            marker="pinned-header"
            label="Pinned"
            visible={from !== null}
            isDropTarget={dragTargetSection === "pinned"}
          />
        );
      case "pinned-divider":
        return (
          <SidebarDragBoundary
            key={markerKey}
            scope={scope}
            marker="pinned-divider"
            label="Active"
            visible={from !== null}
            isDropTarget={dragTargetSection === "active"}
          />
        );
      case "active-placeholder": {
        const activeCount = openCount("active");
        return (
          <SidebarSectionPlaceholder
            key={markerKey}
            scope={scope}
            marker="active-placeholder"
            label="Active"
            showHint={
              from !== null &&
              (activeCount === 0 ||
                (from === "active" &&
                  activeCount === 1 &&
                  dragTargetSection !== null &&
                  dragTargetSection !== "active"))
            }
            isDropTarget={dragTargetSection === "active"}
          />
        );
      }
      case "working-header":
      case "snoozed-header":
        return (
          <SortableSidebarMarker
            key={markerKey}
            scope={scope}
            marker={item.marker}
            className="h-0"
          />
        );
      case "settled-header":
        return (
          <SortableSidebarMarker
            key={markerKey}
            scope={scope}
            marker="settled-header"
            data-testid="sidebar-settled-header"
            className={cn(
              "rounded-md",
              group.settledThreads.length === 0 && "h-0",
              dragTargetSection === "settled" && "bg-primary/5 text-primary",
            )}
          >
            {group.settledThreads.length === 0 ? null : (
              <SidebarMenuSubButton
                className="w-full"
                aria-expanded={entry.settledExpanded}
                data-testid="sidebar-settled-shelf-toggle"
                onClick={() => props.onToggleSettled(scope)}
                render={<button type="button" />}
              >
                <CheckCheckIcon className="size-3.5" />
                <span className="text-sidebar-muted-foreground">Settled</span>
                <span className="ms-auto rounded-full bg-sidebar-row-hover px-1.5 text-3xs tabular-nums text-sidebar-muted-foreground">
                  {group.settledThreads.length}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    !entry.settledExpanded && "-rotate-90",
                  )}
                />
              </SidebarMenuSubButton>
            )}
          </SortableSidebarMarker>
        );
      case "settled-placeholder": {
        const settledCount = openCount("settled");
        return (
          <SidebarSectionPlaceholder
            key={markerKey}
            scope={scope}
            marker="settled-placeholder"
            label="Settled"
            showHint={
              from !== null &&
              (settledCount === 0 ||
                (from === "settled" &&
                  settledCount === 1 &&
                  dragTargetSection !== null &&
                  dragTargetSection !== "settled"))
            }
            isDropTarget={dragTargetSection === "settled"}
          />
        );
      }
    }
  };
  const settledStart = items.findIndex(
    (item) => item.kind === "marker" && item.marker === "settled-placeholder",
  );
  const settledItems = settledStart < 0 ? [] : items.slice(settledStart + 1);
  const showMore =
    expanded && entry.settledExpanded && entry.hasMoreSettled ? (
      <li className="list-none">
        <button
          type="button"
          onClick={() => props.onShowMoreSettled(scope)}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          Show more
        </button>
      </li>
    ) : null;
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-project-group"
      className={cn(
        "list-none",
        !props.first && "mt-2 border-t border-sidebar-border/40 pt-2",
        isDragging && "relative z-20 opacity-80",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="flex items-center gap-1 pe-1">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-expanded={expanded}
          onClick={() => props.onToggleProject(project, expanded)}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          {...attributes}
          {...listeners}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-icon-muted", !expanded && "-rotate-90")}
          />
          <ProjectFavicon project={project} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-sidebar-foreground">
            {project.displayName}
          </span>
          {expanded ? null : <ProjectNotificationDot threads={group.openThreads} />}
        </button>
        <SidebarProjectHoverCard project={project} portCount={props.portCounts.get(scope) ?? 0} />
        <SidebarProjectNewThreadButton project={project} />
      </div>
      <SortableContext
        items={items.map(sidebarListItemId)}
        strategy={drag === null ? idleSortingStrategy : props.dragSortingStrategy}
      >
        <SidebarMenuSub ref={attachList} role="presentation" className="relative mx-1">
          {items.slice(0, settledStart + 1).flatMap(renderItem)}
          {settledItems.length > 0 || showMore ? (
            <li className="list-none">
              <SidebarMenuSub className="mx-1 mt-px">
                {settledItems.flatMap(renderItem)}
                {showMore}
              </SidebarMenuSub>
            </li>
          ) : null}
        </SidebarMenuSub>
      </SortableContext>
    </li>
  );
}

export function SidebarProjectGroups(
  props: Omit<ProjectGroupProps, "entry" | "items" | "portCounts" | "first"> & {
    layout: readonly ProjectLayout[];
    itemsByScope: ReadonlyMap<string, readonly SidebarListItem[]>;
  },
) {
  const { layout, itemsByScope, ...rest } = props;
  // One slow-polling subscription for every project row; a card that opens polls fast itself.
  const showsPorts = useClientSettings((settings) =>
    settings.projectHoverCardProperties.includes("ports"),
  );
  const { ports } = useListeningPorts(showsPorts ? {} : { environmentId: null });
  const portCounts = countLivePortsByProject(
    ports,
    layout.map((entry) => entry.project),
  );
  return layout.map((entry, index) => (
    <SidebarProjectGroup
      key={entry.project.projectKey}
      first={index === 0}
      {...rest}
      portCounts={portCounts}
      entry={entry}
      items={itemsByScope.get(entry.project.projectKey) ?? []}
    />
  ));
}
