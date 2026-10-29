import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, FolderOpenIcon } from "lucide-react";
import { SortableContext, useSortable, type SortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type ReactNode } from "react";

import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-attention";
import { cn } from "~/lib/utils";
import {
  resolveSidebarNotificationDotClass,
  resolveThreadLastVisitedAt,
  resolveWorkingStartedAt,
  sidebarListItemId,
  type SidebarListItem,
  type SidebarSection,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { folderProjectKeysAtom } from "../../hooks/useSidebarProjectGroups";
import { useUiStateStore } from "../../uiStateStore";
import { useClientSettings } from "../../hooks/useSettings";
import { countLivePortsByProject, resolveSubagentDisplay } from "./sidebarDisplay.logic";
import { useListeningPorts } from "../statusBar/useListeningPorts";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SidebarNotificationDot } from "./SidebarNotificationDot";
import { SidebarProjectBoardButton } from "../kanban/SidebarKanbanButtons";
import { SidebarProjectNewThreadButton } from "./SidebarProjectNewThreadButton";
import { SidebarProjectHoverCard } from "./SidebarProjectHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
    <li className="relative list-none">
      <span aria-hidden className="absolute inset-y-0 start-9 w-px bg-sidebar-border" />
      <button
        type="button"
        data-testid="sidebar-subagent-row"
        onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-12 pe-2.5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

/** The project's sidebar tree row; its thread rows name it as their parent. */
function projectRowId(projectKey: string) {
  return `project:${projectKey}`;
}

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
  renderThreadRow: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    projectRow: string,
  ) => ReactNode;
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
      props.renderThreadRow(thread, section, projectRowId(scope)),
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
            className={cn(group.settledThreads.length === 0 ? "h-0" : "ps-7")}
          >
            {group.settledThreads.length === 0 ? null : (
              <CollapsibleSectionHeader
                expanded={entry.settledExpanded}
                tone={
                  dragTargetSection === "settled"
                    ? "accent"
                    : from !== null
                      ? "emphasized"
                      : "muted"
                }
                data-testid="sidebar-settled-shelf-toggle"
                onClick={() => props.onToggleSettled(scope)}
                accessory={
                  <span className="font-normal tabular-nums">{group.settledThreads.length}</span>
                }
              >
                Settled
              </CollapsibleSectionHeader>
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
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md ps-9 pe-2.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          Show more
        </button>
      </li>
    ) : null;
  const isFolder = useAtomValue(folderProjectKeysAtom, (keys) =>
    project.memberProjects.some((member) => keys.has(`${member.environmentId}:${member.id}`)),
  );
  const portCount = props.portCounts.get(scope) ?? 0;
  const hiddenCount = expanded
    ? 0
    : group.openThreads.length -
      items.filter((item) => item.kind === "thread" && item.section !== "settled").length;
  return (
    <li
      ref={setNodeRef}
      data-testid="sidebar-project-group"
      className={cn("list-none", !props.first && "mt-2", isDragging && "relative z-20 opacity-80")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="group/project-header relative rounded-(--control-radius) hover:bg-sidebar-row-hover">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-expanded={expanded}
          onClick={() => props.onToggleProject(project, expanded)}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          {...attributes}
          {...listeners}
          role="treeitem"
          tabIndex={-1}
          data-sidebar-row={projectRowId(scope)}
        >
          {isFolder ? (
            <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
          ) : (
            <ProjectFavicon project={project} className="size-4 shrink-0" />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90" />
              }
            >
              {project.displayName}
            </TooltipTrigger>
            <TooltipPopup side="top">{project.displayName}</TooltipPopup>
          </Tooltip>
          {expanded ? null : <ProjectNotificationDot threads={group.openThreads} />}
          {hiddenCount > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-header:invisible pointer-coarse:invisible">
              {hiddenCount}
            </span>
          ) : null}
          {/* Keeps the count clear of the always-visible ports icon laid over the row. */}
          {portCount > 0 ? <span aria-hidden className="size-5 shrink-0" /> : null}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </button>
        {/* Sits over the count, which hides on hover, and left of the chevron. */}
        <span className="absolute inset-y-0 right-6 flex items-center gap-0.5">
          <span className="flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/project-header:opacity-100 pointer-coarse:opacity-100">
            <SidebarProjectBoardButton project={project} />
            <SidebarProjectNewThreadButton project={project} />
          </span>
          <SidebarProjectHoverCard project={project} portCount={portCount} />
        </span>
      </div>
      <SortableContext
        items={items.map(sidebarListItemId)}
        strategy={drag === null ? idleSortingStrategy : props.dragSortingStrategy}
      >
        <ul ref={attachList} role="presentation" className="relative flex flex-col gap-px">
          {items.slice(0, settledStart + 1).flatMap(renderItem)}
          {settledItems.length > 0 || showMore ? (
            <li className="list-none">
              <ul className="flex flex-col gap-px">
                {settledItems.flatMap(renderItem)}
                {showMore}
              </ul>
            </li>
          ) : null}
        </ul>
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
