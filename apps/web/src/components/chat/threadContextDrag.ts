import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";

import {
  resolveTabDropZone,
  resolveTabInsertIndex,
  type TabDropTarget,
  type TabDropZone,
} from "../../threadTabsStore";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

const GROUPS_ATTRIBUTE = "data-thread-groups";
const STRIP_ATTRIBUTE = "data-thread-tab-strip";
const TAB_ATTRIBUTE = "data-thread-tab";
const BODY_ATTRIBUTE = "data-thread-group-body";
export const THREAD_TAB_DROP_EVENT = "t3-thread-tab-drop";

export interface ThreadTabDropDetail {
  readonly threadKey: string;
  readonly target: TabDropTarget;
}

/** The drop indicator: a zone of a group's body, or an insertion bar in its strip. */
export interface ThreadTabDropPreview {
  readonly kind: "zone" | "insert";
  readonly zone: TabDropZone | null;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ThreadDragLabel {
  readonly title: string;
  readonly count: number;
  /** The one dragged thread; null for several. */
  readonly threadKey: string | null;
  /** `environmentId:projectId` of that thread: tabs only open in their own project's groups. */
  readonly projectKey: string | null;
  /** A tab moves between groups and never mentions itself in a composer. */
  readonly fromTab?: boolean;
}

let dropPreview: ThreadTabDropPreview | null = null;
const dropPreviewListeners = new Set<() => void>();

function setDropPreview(next: ThreadTabDropPreview | null) {
  const same =
    next === dropPreview ||
    (next !== null &&
      dropPreview !== null &&
      next.kind === dropPreview.kind &&
      next.zone === dropPreview.zone &&
      next.left === dropPreview.left &&
      next.top === dropPreview.top &&
      next.width === dropPreview.width &&
      next.height === dropPreview.height);
  if (same) return;
  dropPreview = next;
  for (const listener of dropPreviewListeners) listener();
}

export function useThreadTabDropPreview(): ThreadTabDropPreview | null {
  return useSyncExternalStore(
    (listener) => {
      dropPreviewListeners.add(listener);
      return () => dropPreviewListeners.delete(listener);
    },
    () => dropPreview,
    () => null,
  );
}

export const threadGroupsProps = (projectKey: string) =>
  ({ [GROUPS_ATTRIBUTE]: projectKey }) as const;
export const threadTabStripProps = (groupId: string) => ({ [STRIP_ATTRIBUTE]: groupId }) as const;
export const threadTabProps = (tabKey: string) => ({ [TAB_ATTRIBUTE]: tabKey }) as const;
export const threadGroupBodyProps = (groupId: string) => ({ [BODY_ATTRIBUTE]: groupId }) as const;

function zoneRect(rect: DOMRect, zone: TabDropZone) {
  const { left, top, width, height } = rect;
  switch (zone) {
    case "left":
      return { left, top, width: width / 2, height };
    case "right":
      return { left: left + width / 2, top, width: width / 2, height };
    case "up":
      return { left, top, width, height: height / 2 };
    case "down":
      return { left, top: top + height / 2, width, height: height / 2 };
    case "center":
      return { left, top, width, height };
  }
}

function findTabDrop(
  point: { x: number; y: number },
  label: ThreadDragLabel,
): { groups: HTMLElement; target: TabDropTarget; preview: ThreadTabDropPreview } | null {
  if (label.threadKey === null || label.projectKey === null) return null;
  const element = document.elementFromPoint(point.x, point.y);
  const groups = element?.closest<HTMLElement>(`[${GROUPS_ATTRIBUTE}]`);
  if (!element || !groups || groups.getAttribute(GROUPS_ATTRIBUTE) !== label.projectKey) {
    return null;
  }
  const strip = element.closest<HTMLElement>(`[${STRIP_ATTRIBUTE}]`);
  const stripGroupId = strip?.getAttribute(STRIP_ATTRIBUTE);
  if (strip && stripGroupId) {
    const stripRect = strip.getBoundingClientRect();
    const tabRects = [...strip.querySelectorAll(`[${TAB_ATTRIBUTE}]`)].map((tab) =>
      tab.getBoundingClientRect(),
    );
    const index = resolveTabInsertIndex(tabRects, point.x);
    const x = tabRects[index]?.left ?? tabRects.at(-1)?.right ?? stripRect.left;
    return {
      groups,
      target: { groupId: stripGroupId, index },
      preview: {
        kind: "insert",
        zone: null,
        left: x - 1,
        top: stripRect.top + 4,
        width: 2,
        height: Math.max(0, stripRect.height - 8),
      },
    };
  }
  const body = element.closest<HTMLElement>(`[${BODY_ATTRIBUTE}]`);
  const groupId = body?.getAttribute(BODY_ATTRIBUTE);
  if (!body || !groupId) return null;
  const rect = body.getBoundingClientRect();
  const zone = resolveTabDropZone(rect, point);
  return {
    groups,
    target: { groupId, zone },
    preview: { kind: "zone", zone, ...zoneRect(rect, zone) },
  };
}

export function moveThreadContextDrag(point: { x: number; y: number }, label: ThreadDragLabel) {
  const target = label.fromTab ? null : findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setDropPreview(target === null ? (findTabDrop(point, label)?.preview ?? null) : null);
  setGhost({ x: point.x, y: point.y, title: label.title, count: label.count });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
  setDropPreview(null);
}

/**
 * Drops onto a composer as context; one thread over the thread area opens as a tab where it
 * lands, as Orca does with editor tabs.
 */
export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
  label?: Pick<ThreadDragLabel, "projectKey" | "fromTab">,
): boolean {
  const target = label?.fromTab ? null : findDropTarget(point);
  if (target && threads.length > 0) {
    target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
    return true;
  }
  const [thread] = threads;
  if (thread === undefined || threads.length !== 1) return false;
  const threadKey = scopedThreadKey(thread);
  const drop = findTabDrop(point, {
    title: "",
    count: 1,
    threadKey,
    projectKey: label?.projectKey ?? null,
  });
  if (drop === null) return false;
  drop.groups.dispatchEvent(
    new CustomEvent<ThreadTabDropDetail>(THREAD_TAB_DROP_EVENT, {
      detail: { threadKey, target: drop.target },
    }),
  );
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
