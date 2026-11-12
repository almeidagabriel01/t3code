import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { isElectron } from "../../env";
import { resolveShortcutCommand } from "../../keybindings";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  clampSplitRatio,
  closeThreadTab,
  DEFAULT_SPLIT_RATIO,
  applyThreadTabDrop,
  focusThreadTabGroup,
  groupOfTab,
  layoutGeometry,
  type LayoutRect,
  reconcileRouteTab,
  setThreadSplitRatio,
  type ThreadTabGroup,
  type ThreadTabLayout,
  type ThreadTabWorkspace,
  updateThreadTabs,
  useThreadTabsStore,
  withRouteTab,
} from "../../threadTabsStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import ChatView from "../ChatView";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
  THREAD_TAB_DROP_EVENT,
  type ThreadTabDropDetail,
  threadGroupBodyProps,
  threadGroupsProps,
  threadTabProps,
  threadTabStripProps,
} from "./threadContextDrag";
import { threadTabsProjectKey } from "./threadTabsProject";

/** Below two groups of this width side by side, only the routed thread's group shows. */
const MIN_TAB_GROUP_WIDTH = 320;
const RATIO_STEP = 0.05;

/** A group touching the window's top edge carries the titlebar; its side edges carry insets. */
function rectEdges(rect: LayoutRect | undefined) {
  if (!rect) return { top: true, left: true, right: true };
  return {
    top: rect.top < 0.001,
    left: rect.left < 0.001,
    right: rect.left + rect.width > 0.999,
  };
}

const percent = (value: number) => `${value * 100}%`;
const rectStyle = (rect: LayoutRect): CSSProperties => ({
  position: "absolute",
  left: percent(rect.left),
  top: percent(rect.top),
  width: percent(rect.width),
  height: percent(rect.height),
});

function dividerStyle(
  split: Extract<ThreadTabLayout, { type: "split" }>,
  rect: LayoutRect,
): CSSProperties {
  return split.direction === "horizontal"
    ? {
        left: percent(rect.left + rect.width * split.ratio),
        top: percent(rect.top),
        height: percent(rect.height),
      }
    : {
        top: percent(rect.top + rect.height * split.ratio),
        left: percent(rect.left),
        width: percent(rect.width),
      };
}

/** Writes a layout to the groups and dividers already on screen; a divider drag uses it per frame. */
function applyLayoutStyles(container: HTMLElement, layout: ThreadTabLayout) {
  const { groups, dividers } = layoutGeometry(layout);
  for (const element of container.querySelectorAll<HTMLElement>(":scope > [data-thread-group]")) {
    const rect = groups.get(element.dataset.threadGroup ?? "");
    if (rect) Object.assign(element.style, rectStyle(rect));
  }
  for (const { split, rect } of dividers) {
    const element = container.querySelector<HTMLElement>(
      `:scope > [data-thread-divider="${split.id}"]`,
    );
    if (element) Object.assign(element.style, dividerStyle(split, rect));
  }
}

function useNavigateToThreadKey() {
  const navigate = useNavigate();
  return (key: string | null) => {
    const ref = key === null ? null : parseScopedThreadKey(key);
    if (ref)
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    else void navigate({ to: "/" });
  };
}

/** Starts dragging a tab; it drops like a sidebar thread but never into a composer. */
function startThreadTabDrag(
  event: PointerEvent,
  thread: ScopedThreadRef,
  title: string,
  projectKey: string,
) {
  if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
  const label = {
    title,
    count: 1,
    threadKey: scopedThreadKey(thread),
    projectKey,
    fromTab: true,
  } as const;
  return new SidebarPointerSensor({
    event,
    active: label.threadKey,
    options: {
      distance: 6,
      onAttach: () => {},
      onFinish: endThreadContextDrag,
      onDrop: (point) => dropThreadContext(point, [thread], label),
    },
    onStart: () => {},
    onMove: (point) => moveThreadContextDrag(point, label),
    onPending: () => {},
    onAbort: () => {},
    onCancel: () => {},
    onEnd: () => {},
  });
}

const FOCUSED_GROUP_CLASS =
  "after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:z-30 after:h-0.5 after:bg-primary/55";

/**
 * Tab groups around the routed ChatView. Its chat column keeps its place in the tree, so opening,
 * moving or closing groups never remounts it; with several groups every group, the column
 * included, is placed absolutely from the layout tree.
 */
export function useThreadTabsLayout(input: {
  readonly routeThreadRef: ScopedThreadRef;
  readonly enabled: boolean;
}) {
  const navigateToThreadKey = useNavigateToThreadKey();
  const routeShell = useQuietThreadShell(input.enabled ? input.routeThreadRef : null);
  const routeKey = scopedThreadKey(input.routeThreadRef);
  const projectKey = input.enabled ? threadTabsProjectKey(routeShell) : null;
  const stored = useThreadTabsStore((state) =>
    projectKey === null ? undefined : state.byProject[projectKey],
  );
  // Until the commit below lands, render the route as already opened.
  const workspace = projectKey === null ? null : withRouteTab(stored, routeKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commits a route change into the persisted tab layout (open or focus its tab)
  useEffect(() => {
    if (projectKey !== null)
      updateThreadTabs(projectKey, (current) => reconcileRouteTab(current, routeKey));
  }, [projectKey, routeKey]);

  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fits, setFits] = useState(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the thread area to fold groups when two cannot fit side by side
  useEffect(() => {
    if (!container) return;
    return observeResize(container, (entries) => {
      const entry = entries.at(-1);
      if (entry) setFits(entry.contentRect.width >= MIN_TAB_GROUP_WIDTH * 2);
    });
  }, [container]);

  const closeTab = (tabKey: string) => {
    if (projectKey === null) return;
    let navigateTo: string | null | undefined;
    updateThreadTabs(projectKey, (current) => {
      if (!current) return current;
      const closed = closeThreadTab(current, tabKey, routeKey);
      navigateTo = closed.navigateTo;
      return closed.workspace;
    });
    if (navigateTo !== undefined) navigateToThreadKey(navigateTo);
  };

  const onTabDrop = useEffectEvent((detail: ThreadTabDropDetail) => {
    if (projectKey === null) return;
    const moved = applyThreadTabDrop(projectKey, routeKey, detail.threadKey, detail.target);
    // The dropped thread becomes the full pane, as a tab picked in Orca becomes the active editor.
    if (moved && detail.threadKey !== routeKey) navigateToThreadKey(detail.threadKey);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the thread area to tab drops dispatched by the drag sensor
  useEffect(() => {
    if (!container) return;
    const listener = (event: Event) =>
      onTabDrop((event as CustomEvent<ThreadTabDropDetail>).detail);
    container.addEventListener(THREAD_TAB_DROP_EVENT, listener);
    return () => container.removeEventListener(THREAD_TAB_DROP_EVENT, listener);
  }, [container]);

  const routeGroup = workspace ? groupOfTab(workspace, routeKey) : undefined;
  const split = workspace !== null && workspace.groups.length > 1 && fits;
  const geometry = split ? layoutGeometry(workspace.layout) : null;
  const routeRect = routeGroup ? geometry?.groups.get(routeGroup.id) : undefined;
  const focus = (groupId: string) => () => {
    if (projectKey !== null) {
      updateThreadTabs(projectKey, (current) => current && focusThreadTabGroup(current, groupId));
    }
  };

  return {
    containerProps: {
      ref: setContainer,
      // The glass titlebar band paints on the row around this area (liquidGlass.css).
      "data-thread-area": true,
      ...(projectKey !== null ? threadGroupsProps(projectKey) : {}),
    },
    columnProps: routeGroup
      ? {
          "data-thread-group": routeGroup.id,
          ...threadGroupBodyProps(routeGroup.id),
          onPointerDownCapture: focus(routeGroup.id),
          ...(routeRect ? { style: rectStyle(routeRect) } : {}),
        }
      : {},
    columnClassName:
      split && workspace.focusedGroupId === routeGroup?.id ? FOCUSED_GROUP_CLASS : null,
    routeEdges: rectEdges(routeRect),
    routeStrip:
      routeGroup && projectKey !== null ? (
        <ThreadTabStrip group={routeGroup} projectKey={projectKey} onClose={closeTab} />
      ) : null,
    groups:
      split && geometry && projectKey !== null && container ? (
        <>
          {workspace.groups.map((group) => {
            const rect = geometry.groups.get(group.id);
            if (group.id === routeGroup?.id || !rect) return null;
            return (
              <ThreadTabGroupPane
                key={group.id}
                group={group}
                rect={rect}
                focused={workspace.focusedGroupId === group.id}
                projectKey={projectKey}
                onFocus={focus(group.id)}
                onClose={closeTab}
              />
            );
          })}
          {geometry.dividers.map(({ split: node, rect }) => (
            <ThreadTabDivider
              key={node.id}
              split={node}
              rect={rect}
              container={container}
              workspace={workspace}
              projectKey={projectKey}
            />
          ))}
        </>
      ) : null,
    /** Cmd+W outside the right panel closes the routed tab. */
    closeRouteTab: (): boolean => {
      if (projectKey === null) return false;
      closeTab(routeKey);
      return true;
    },
  };
}

function ThreadTabStrip(props: {
  readonly group: ThreadTabGroup;
  readonly projectKey: string;
  readonly onClose: (tabKey: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Open threads"
      {...threadTabStripProps(props.group.id)}
      className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-foreground/10 px-1 [scrollbar-width:none]"
    >
      {props.group.tabs.map((tabKey) => (
        <ThreadTab
          key={tabKey}
          tabKey={tabKey}
          active={tabKey === props.group.active}
          projectKey={props.projectKey}
          onClose={props.onClose}
        />
      ))}
    </div>
  );
}

function ThreadTab(props: {
  readonly tabKey: string;
  readonly active: boolean;
  readonly projectKey: string;
  readonly onClose: (tabKey: string) => void;
}) {
  const ref = parseScopedThreadKey(props.tabKey);
  const shell = useQuietThreadShell(ref);
  const navigateToThreadKey = useNavigateToThreadKey();
  const deleted = shell?.deletedAt != null;
  const title = shell?.title.trim() || "Thread";
  const close = () => props.onClose(props.tabKey);
  return (
    <div
      role="tab"
      aria-label={title}
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      {...threadTabProps(props.tabKey)}
      onClick={() => navigateToThreadKey(props.tabKey)}
      onMouseDown={(event) => {
        // A middle press would start the browser's autoscroll.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          navigateToThreadKey(props.tabKey);
        }
      }}
      onPointerDown={(event) => {
        if (ref) startThreadTabDrag(event.nativeEvent, ref, title, props.projectKey);
      }}
      className={cn(
        "group/tab my-1 flex w-40 min-w-24 shrink cursor-pointer items-center gap-1 rounded-md pr-1 pl-2.5 text-xs select-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={<span className={cn("min-w-0 flex-1 truncate", deleted && "line-through")} />}
        >
          {title}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{title}</TooltipPopup>
      </Tooltip>
      <span
        className={cn(
          "flex shrink-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
          props.active ? "opacity-100" : "opacity-0",
        )}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            close();
          }}
        >
          <XIcon />
        </Button>
      </span>
    </div>
  );
}

function ThreadTabGroupPane(props: {
  readonly group: ThreadTabGroup;
  readonly rect: LayoutRect;
  readonly focused: boolean;
  readonly projectKey: string;
  readonly onFocus: () => void;
  readonly onClose: (tabKey: string) => void;
}) {
  const { group } = props;
  const activeRef = parseScopedThreadKey(group.active);
  const shell = useQuietThreadShell(activeRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigateToThreadKey = useNavigateToThreadKey();
  const edges = rectEdges(props.rect);
  const title = shell?.title.trim() || "Thread";
  // The routed ChatView ignores keys from embedded panes, so this group takes its own Cmd+W.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = resolveShortcutCommand(event.nativeEvent, keybindings, {
      context: { terminalFocus: false },
    });
    if (command !== "rightPanel.close" || event.repeat) return;
    event.preventDefault();
    props.onClose(group.active);
  };
  return (
    <div
      data-thread-group={group.id}
      {...threadGroupBodyProps(group.id)}
      data-side-chat-pane
      onPointerDownCapture={props.onFocus}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        props.focused && FOCUSED_GROUP_CLASS,
      )}
      style={rectStyle(props.rect)}
    >
      <header
        data-chat-header
        data-glass-layer
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3",
          isElectron && edges.top && "drag-region",
          edges.top && edges.left && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          // The panel toggles sit fixed at the window's top-right corner.
          edges.top && edges.right && "pr-24",
          isElectron && edges.top && edges.right && "wco:pr-(--workspace-native-controls-inset)",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => navigateToThreadKey(group.active)}
                className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground/85 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]"
              />
            }
          >
            {title}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open with its panels and terminal</TooltipPopup>
        </Tooltip>
      </header>
      <ThreadTabStrip group={group} projectKey={props.projectKey} onClose={props.onClose} />
      <div className="relative flex min-h-0 flex-1">
        {activeRef ? (
          <BackgroundThreadContext value>
            <ComposerHandleContext value={null}>
              <ChatView
                key={group.active}
                environmentId={activeRef.environmentId}
                threadId={activeRef.threadId}
                routeKind="server"
                reserveTitleBarControlInset={false}
                embedded
              />
            </ComposerHandleContext>
          </BackgroundThreadContext>
        ) : null}
      </div>
    </div>
  );
}

function ThreadTabDivider(props: {
  readonly split: Extract<ThreadTabLayout, { type: "split" }>;
  readonly rect: LayoutRect;
  readonly container: HTMLElement;
  readonly workspace: ThreadTabWorkspace;
  readonly projectKey: string;
}) {
  const { split, rect, container, workspace, projectKey } = props;
  const horizontal = split.direction === "horizontal";
  const dragRef = useRef<{ ratio: number } | null>(null);
  const commit = (ratio: number) =>
    updateThreadTabs(
      projectKey,
      (current) => current && setThreadSplitRatio(current, split.id, ratio),
    );

  const ratioAt = (event: ReactPointerEvent) => {
    const box = container.getBoundingClientRect();
    return horizontal
      ? (event.clientX - box.left - rect.left * box.width) / (rect.width * box.width)
      : (event.clientY - box.top - rect.top * box.height) / (rect.height * box.height);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { ratio: split.ratio };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current.ratio = clampSplitRatio(ratioAt(event));
    // Writes the panes directly; the store takes the ratio once, on release.
    applyLayoutStyles(
      container,
      setThreadSplitRatio(workspace, split.id, dragRef.current.ratio).layout,
    );
  };
  const finish = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.ratio !== split.ratio) commit(drag.ratio);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
        ? -RATIO_STEP
        : event.key === (horizontal ? "ArrowRight" : "ArrowDown")
          ? RATIO_STEP
          : null;
    if (step !== null) {
      event.preventDefault();
      commit(split.ratio + step);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(DEFAULT_SPLIT_RATIO);
    }
  };
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label="Resize tab groups"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split.ratio * 100)}
      tabIndex={0}
      data-thread-divider={split.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => commit(DEFAULT_SPLIT_RATIO)}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute z-20 touch-none select-none focus-visible:outline-hidden",
        horizontal ? "-ml-1 w-2 cursor-col-resize" : "-mt-1 h-2 cursor-row-resize",
      )}
      style={dividerStyle(split, rect)}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-foreground/12 transition-colors duration-150 group-hover:bg-foreground/30 group-focus-visible:bg-primary/70 group-active:bg-primary/70",
          horizontal ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px",
        )}
      />
    </div>
  );
}
