import { GitForkIcon, XIcon } from "lucide-react";
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
  const label = `T3 Code ${tag} is out upstream. Update your fork.`;

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

/** Hidden unless the local server holds a fork checkout that is behind a newer upstream release. */
export function SidebarForkUpdatePill() {
  const environmentId = useForkUpdatesEnvironmentId();
  return environmentId === null ? null : <ForkUpdatePill environmentId={environmentId} />;
}
