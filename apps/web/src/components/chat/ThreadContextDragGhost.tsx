import { MessagesSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useThreadContextDragGhost, useThreadTabDropPreview } from "./threadContextDrag";

const PREVIEW_INSET = 6;

export function ThreadContextDragGhost() {
  const ghost = useThreadContextDragGhost();
  const preview = useThreadTabDropPreview();
  if (ghost === null) return null;
  return createPortal(
    <>
      {preview ? (
        // Moves between zones by transition only; nothing repaints while the pointer rests.
        <div
          aria-hidden="true"
          data-thread-tab-drop-preview={preview.zone ?? "insert"}
          className={
            preview.kind === "insert"
              ? "pointer-events-none fixed z-[90] rounded-full bg-primary"
              : "pointer-events-none fixed z-[90] rounded-xl border border-primary/45 bg-primary/15 transition-[left,top,width,height,opacity] duration-200 ease-out starting:opacity-0 motion-reduce:transition-none"
          }
          style={
            preview.kind === "insert"
              ? {
                  left: preview.left,
                  top: preview.top,
                  width: preview.width,
                  height: preview.height,
                }
              : {
                  left: preview.left + PREVIEW_INSET,
                  top: preview.top + PREVIEW_INSET,
                  width: Math.max(0, preview.width - PREVIEW_INSET * 2),
                  height: Math.max(0, preview.height - PREVIEW_INSET * 2),
                }
          }
        />
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[100] flex max-w-72 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
        style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
      >
        <MessagesSquareIcon className="size-4 shrink-0 text-secondary-label" />
        <span className="truncate">{ghost.title}</span>
        {ghost.count > 1 ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-secondary-label">
            +{ghost.count - 1}
          </span>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
