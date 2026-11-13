import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAssistantThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useThreadTabsStore } from "../threadTabsStore";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "./chat/threadContextDrag";
import { readThreadTabsProjectKey } from "./chat/threadTabsProject";

/** Drags one thread from outside the sidebar's sortable list onto a composer or into a split. */
export function startThreadDrag(
  event: PointerEvent,
  thread: ScopedThreadRef,
  title: string,
  onStart?: () => void,
) {
  if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
  const label = {
    title,
    count: 1,
    threadKey: scopedThreadKey(thread),
    // An assistant chat has no project, so it splits whichever workspace is on screen.
    projectKey:
      readThreadTabsProjectKey(thread) ??
      (isAssistantThreadId(thread.threadId) ? useThreadTabsStore.getState().visibleKey : null),
  };
  // The document-owned sensor must survive its source closing or unmounting on activation.
  return new SidebarPointerSensor({
    event,
    active: scopedThreadKey(thread),
    options: {
      distance: 6,
      onAttach: () => {},
      onFinish: endThreadContextDrag,
      onDrop: (point) => dropThreadContext(point, [thread], label),
    },
    onStart: () => onStart?.(),
    onMove: (point) => moveThreadContextDrag(point, label),
    onPending: () => {},
    onAbort: () => {},
    onCancel: () => {},
    onEnd: () => {},
  });
}
