import { MessageSquare } from "lucide-react";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";

import type { RightPanelSurface } from "../../rightPanelStore";
import { PierreEntryIcon } from "./PierreEntryIcon";

type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

const TAB_CLASS =
  "group/tab flex h-6 max-w-44 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs";

function tabStateClass(active: boolean) {
  return active
    ? "bg-accent text-foreground"
    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground";
}

function fileName(surface: FileSurface) {
  return surface.relativePath.split("/").findLast(Boolean) ?? surface.relativePath;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventMiddleButtonDefault(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

export function MainFileTabs(props: {
  readonly files: readonly FileSurface[];
  readonly activeFileId: string | null;
  readonly pendingIds: ReadonlySet<string>;
  readonly onShowChat: () => void;
  readonly onActivate: (surface: FileSurface) => void;
  readonly onClose: (surface: FileSurface) => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <div
      role="tablist"
      aria-label="Thread views"
      className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2"
    >
      <button
        type="button"
        role="tab"
        aria-selected={props.activeFileId === null}
        className={cn(TAB_CLASS, "gap-1.5", tabStateClass(props.activeFileId === null))}
        onClick={props.onShowChat}
      >
        <MessageSquare className="size-3 shrink-0" />
        Chat
      </button>
      {props.files.map((surface) => {
        const active = surface.id === props.activeFileId;
        const name = fileName(surface);
        return (
          <div
            key={surface.id}
            role="tab"
            aria-selected={active}
            data-active-tab={active}
            className={cn(TAB_CLASS, tabStateClass(active))}
            onMouseDown={preventMiddleButtonDefault}
            onMouseUp={preventMiddleButtonDefault}
            onAuxClick={(event) => {
              if (event.button === 1) props.onClose(surface);
            }}
          >
            <PanelTabCloseButton label={`Close ${name}`} onClick={() => props.onClose(surface)}>
              <PierreEntryIcon
                pathValue={surface.relativePath}
                kind="file"
                theme={resolvedTheme}
                className="size-3"
              />
              {props.pendingIds.has(surface.id) ? (
                <span
                  className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                  aria-hidden
                />
              ) : null}
            </PanelTabCloseButton>
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate"
              onClick={() => props.onActivate(surface)}
            >
              {name}
            </button>
          </div>
        );
      })}
    </div>
  );
}
