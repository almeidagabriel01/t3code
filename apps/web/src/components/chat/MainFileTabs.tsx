import { MessageSquareIcon, XIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";

import type { ThreadFileSurface } from "../../threadTabsStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";

export const TAB_CLASS =
  "group/tab my-1 flex shrink cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-xs select-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function tabStateClass(active: boolean) {
  return active
    ? "bg-foreground/10 text-foreground"
    : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground";
}

const STRIP_CLASS =
  "flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-foreground/10 px-1 [scrollbar-width:none]";

function fileName(surface: ThreadFileSurface) {
  return surface.relativePath.split("/").findLast(Boolean) ?? surface.relativePath;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventMiddleButtonDefault(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

function activateOnKey(event: KeyboardEvent, activate: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

/** Muted at rest; shows on the active tab, on hover and on focus. */
export function TabCloseButton(props: {
  readonly label: string;
  readonly active: boolean;
  readonly onClose: () => void;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
        props.active ? "opacity-100" : "opacity-0",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={props.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                props.onClose();
              }}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close</TooltipPopup>
      </Tooltip>
    </span>
  );
}

export function FileTab(props: {
  readonly surface: ThreadFileSurface;
  readonly active: boolean;
  readonly pending: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const name = fileName(props.surface);
  return (
    <div
      role="tab"
      aria-label={name}
      aria-selected={props.active}
      tabIndex={props.active ? 0 : -1}
      onClick={props.onActivate}
      onMouseDown={preventMiddleButtonDefault}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose();
      }}
      onKeyDown={(event) => activateOnKey(event, props.onActivate)}
      className={cn(TAB_CLASS, "max-w-44 min-w-20", tabStateClass(props.active))}
    >
      <span className="relative flex shrink-0">
        <PierreEntryIcon
          pathValue={props.surface.relativePath}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5"
        />
        {props.pending ? (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
            aria-hidden
          />
        ) : null}
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {name}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{props.surface.relativePath}</TooltipPopup>
      </Tooltip>
      <TabCloseButton label={`Close ${name}`} active={props.active} onClose={props.onClose} />
    </div>
  );
}

/** One row for a view without thread tabs: its chat, then the files it opened. */
export function MainFileTabs(props: {
  readonly title: string;
  readonly files: readonly ThreadFileSurface[];
  readonly activeFileId: string | null;
  readonly pendingIds: ReadonlySet<string>;
  readonly onShowChat: () => void;
  readonly onActivate: (surface: ThreadFileSurface) => void;
  readonly onClose: (surface: ThreadFileSurface) => void;
}) {
  const chatActive = props.activeFileId === null;
  const title = props.title.trim() || "Thread";
  return (
    <div role="tablist" aria-label="Open tabs" className={STRIP_CLASS}>
      <div
        role="tab"
        aria-label={title}
        aria-selected={chatActive}
        tabIndex={chatActive ? 0 : -1}
        onClick={props.onShowChat}
        onKeyDown={(event) => activateOnKey(event, props.onShowChat)}
        className={cn(TAB_CLASS, "w-40 min-w-24 pr-2.5", tabStateClass(chatActive))}
      >
        <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
            {title}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{title}</TooltipPopup>
        </Tooltip>
      </div>
      {props.files.map((surface) => (
        <FileTab
          key={surface.id}
          surface={surface}
          active={surface.id === props.activeFileId}
          pending={props.pendingIds.has(surface.id)}
          onActivate={() => props.onActivate(surface)}
          onClose={() => props.onClose(surface)}
        />
      ))}
    </div>
  );
}
