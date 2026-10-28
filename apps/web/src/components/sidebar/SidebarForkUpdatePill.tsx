import { GitForkIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { shouldNotifyForkUpdate } from "../forkUpdates/forkUpdates.logic";
import { useForkUpdatesEnvironmentId, useForkUpdateStatus } from "../forkUpdates/useForkUpdates";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";
import { cn } from "../../lib/utils";

type ForkUpdatePlacement = "footer" | "rail";

function ForkUpdatePill({
  environmentId,
  placement,
}: {
  readonly environmentId: EnvironmentId;
  readonly placement: ForkUpdatePlacement;
}) {
  const inRail = placement === "rail";
  const dismissedTag = useClientSettings((settings) => settings.forkUpdatesDismissedTag);
  const { status } = useForkUpdateStatus(environmentId);
  if (status === null || !shouldNotifyForkUpdate(status, dismissedTag)) return null;
  const tag = status.upstreamTag!;
  const label = `T3 Code ${tag} is out upstream (${status.channel}). Update your fork.`;

  const control = (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/settings/fork-updates"
              aria-label={label}
              className={cn(
                "inline-flex items-center justify-center bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                inRail
                  ? "size-10 rounded-lg hover:bg-accent"
                  : "size-8 rounded-full hover:bg-sidebar-row-hover",
              )}
            >
              <GitForkIcon className={inRail ? "size-5" : "size-4"} />
            </Link>
          }
        />
        <TooltipPopup side={inRail ? "right" : "top"}>{label}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        aria-label={`Dismiss ${tag}`}
        className={cn(
          "inline-flex cursor-pointer items-center justify-center rounded-full text-(--sidebar-icon-color) hover:text-sidebar-foreground",
          // The rail has no room beside the button, so dismiss sits on its corner while hovered.
          inRail
            ? "absolute -top-1 -right-1 size-4 bg-background opacity-0 group-hover/fork-update:opacity-100 focus-visible:opacity-100"
            : "size-5",
        )}
        onClick={() => void updateClientSettings({ forkUpdatesDismissedTag: tag })}
      >
        <XIcon className="size-3" />
      </button>
    </>
  );

  return inRail ? (
    <div className="group/fork-update relative flex shrink-0">{control}</div>
  ) : (
    <SidebarMenuItem className="ml-auto flex shrink-0 items-center">{control}</SidebarMenuItem>
  );
}

const FIRST_CHECK_DELAY_MS = 2 * 60_000;

/** True once the delay passed with the page visible, so app start never runs `git fetch`. */
function useAfterStartupDelay() {
  const [ready, setReady] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer and visibility are external
  useEffect(() => {
    let elapsed = false;
    const open = () => {
      if (elapsed && !document.hidden) setReady(true);
    };
    const timer = setTimeout(() => {
      elapsed = true;
      open();
    }, FIRST_CHECK_DELAY_MS);
    document.addEventListener("visibilitychange", open);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", open);
    };
  }, []);
  return ready;
}

/** Hidden unless the local server holds a fork checkout that is behind a newer upstream release. */
export function SidebarForkUpdatePill({
  placement = "footer",
}: {
  readonly placement?: ForkUpdatePlacement;
}) {
  const environmentId = useForkUpdatesEnvironmentId();
  const ready = useAfterStartupDelay();
  return environmentId === null || !ready ? null : (
    <ForkUpdatePill environmentId={environmentId} placement={placement} />
  );
}
