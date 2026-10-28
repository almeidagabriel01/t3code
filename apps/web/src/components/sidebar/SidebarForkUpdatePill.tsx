import { GitForkIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { shouldNotifyForkUpdate } from "../forkUpdates/forkUpdates.logic";
import { useForkUpdatesEnvironmentId, useForkUpdateStatus } from "../forkUpdates/useForkUpdates";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentId } from "@t3tools/contracts";

function ForkUpdatePill({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const dismissedTag = useClientSettings((settings) => settings.forkUpdatesDismissedTag);
  const { status } = useForkUpdateStatus(environmentId);
  if (status === null || !shouldNotifyForkUpdate(status, dismissedTag)) return null;
  const tag = status.upstreamTag!;
  const label = `T3 Code ${tag} is out upstream (${status.channel}). Update your fork.`;

  return (
    <SidebarMenuItem className="ml-auto flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/settings/fork-updates"
              aria-label={label}
              className="inline-flex size-8 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
            >
              <GitForkIcon className="size-4" />
            </Link>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        aria-label={`Dismiss ${tag}`}
        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-(--sidebar-icon-color) hover:text-sidebar-foreground"
        onClick={() => void updateClientSettings({ forkUpdatesDismissedTag: tag })}
      >
        <XIcon className="size-3" />
      </button>
    </SidebarMenuItem>
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
export function SidebarForkUpdatePill() {
  const environmentId = useForkUpdatesEnvironmentId();
  const ready = useAfterStartupDelay();
  return environmentId === null || !ready ? null : <ForkUpdatePill environmentId={environmentId} />;
}
