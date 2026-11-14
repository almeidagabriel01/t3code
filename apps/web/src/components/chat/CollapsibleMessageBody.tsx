import { foldToggleLabel, isLongMessage } from "@t3tools/client-runtime/messageFold";
import { useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { findRevealRef } from "./markdownFindContext";

const FADE_HEIGHT_REM = 1.75;
const FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${FADE_HEIGHT_REM}rem), transparent)`;

/** Folds a long message body behind a fade and a toggle; find reveals it when a match is inside. */
export function CollapsibleMessageBody(props: {
  text: string;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = props.collapsible !== false && hasVisibleBody && isLongMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={isCollapsed ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : undefined}
        >
          {props.children}
        </div>
      ) : null}
      {canCollapse ? (
        <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1"
          >
            {foldToggleLabel(expanded)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
