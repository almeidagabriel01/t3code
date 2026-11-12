import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { dispatchCommandPalette } from "../commandPaletteStore";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "./chat/threadContextDrag";
import { readThreadTabsProjectKey } from "./chat/threadTabsProject";

export function startPaletteThreadDrag(
  event: PointerEvent,
  thread: ScopedThreadRef,
  title: string,
) {
  if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
  const label = {
    title,
    count: 1,
    threadKey: scopedThreadKey(thread),
    projectKey: readThreadTabsProjectKey(thread),
  };
  // The document-owned sensor must survive closing and unmounting the palette on activation.
  return new SidebarPointerSensor({
    event,
    active: scopedThreadKey(thread),
    options: {
      distance: 6,
      onAttach: () => {},
      onFinish: endThreadContextDrag,
      onDrop: (point) => dropThreadContext(point, [thread], label),
    },
    onStart: () => {
      flushSync(() => dispatchCommandPalette({ _tag: "SetOpen", open: false }));
    },
    onMove: (point) => moveThreadContextDrag(point, label),
    onPending: () => {},
    onAbort: () => {},
    onCancel: () => {},
    onEnd: () => {},
  });
}
