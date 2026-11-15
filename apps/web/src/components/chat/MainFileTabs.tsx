import { MessageSquareIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";

import type { ThreadFileSurface } from "../../threadTabsStore";
import { panelTabKeyAction } from "../tabKeyAction";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";

// Every tab takes an equal share of the row, capped at its own width, so short labels stay whole
// and long ones split what is left. `TabLabel` sets how far a tab may shrink.
export const TAB_CLASS =
  "group/tab my-1 flex max-w-max grow basis-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-xs select-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function tabStateClass(active: boolean) {
  return active
    ? "bg-foreground/10 text-foreground"
    : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground";
}

const STRIP_CLASS =
  "@container flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-foreground/10 px-1 [scrollbar-width:none]";

function fileName(surface: ThreadFileSurface) {
  return surface.relativePath.split("/").findLast(Boolean) ?? surface.relativePath;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventMiddleButtonDefault(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

/** Enter or Space on the tab itself; on its × they press the button instead. */
export function activateOnKey(event: KeyboardEvent, activate: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

/** A strip out of room scrolls, so the tab brings itself into view when it becomes active. */
export function useRevealWhenActive(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the strip, a DOM position React does not own
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return ref;
}

/**
 * The label wraps anywhere, so only its hidden copy, capped at a few characters (more on the
 * active tab, less in a narrow strip), holds the tab's minimum width; a shorter label is never
 * padded out.
 */
export function TabLabel(props: {
  readonly text: string;
  readonly tooltip: string;
  readonly active: boolean;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-label={props.text}
            className={cn(
              "min-w-0 flex-1 after:invisible after:block after:h-0 after:overflow-hidden after:whitespace-nowrap after:content-[attr(data-label)]",
              props.active ? "after:max-w-[min(8rem,25cqw)]" : "after:max-w-[min(2.5rem,8cqw)]",
            )}
          />
        }
      >
        <span className={cn("line-clamp-1 break-all", props.className)}>{props.text}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** On a tablist: the arrows, Home and End move focus between its tabs; a tab activates itself. */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const index = tabs.findIndex((tab) => tab === event.target);
  const action = index < 0 ? null : panelTabKeyAction(event.key, index, tabs.length);
  if (action?.type !== "focus") return;
  event.preventDefault();
  tabs[action.index]?.focus();
  tabs[action.index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  const ref = useRevealWhenActive(props.active);
  return (
    <div
      ref={ref}
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
      className={cn(TAB_CLASS, tabStateClass(props.active))}
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
      <TabLabel text={name} tooltip={props.surface.relativePath} active={props.active} />
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
  const chatRef = useRevealWhenActive(chatActive);
  return (
    <div role="tablist" aria-label="Open tabs" className={STRIP_CLASS} onKeyDown={moveTabFocus}>
      <div
        ref={chatRef}
        role="tab"
        aria-label={title}
        aria-selected={chatActive}
        tabIndex={chatActive ? 0 : -1}
        onClick={props.onShowChat}
        onKeyDown={(event) => activateOnKey(event, props.onShowChat)}
        className={cn(TAB_CLASS, "pr-2.5", tabStateClass(chatActive))}
      >
        <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
        <TabLabel text={title} tooltip={title} active={chatActive} />
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
