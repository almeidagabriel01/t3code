import { useAtomValue } from "@effect/atom-react";
import { BellIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SIDEBAR_ACTIVITY_VIEW_KEY = "t3code:sidebar:activity-view";
// Projects is this fork's default view; Activity is opt-in per device.
const SIDEBAR_ACTIVITY_VIEW_DEFAULT = false;

export function useSidebarActivityToggle() {
  const [activityActive, setActivityActive] = useLocalStorage(
    SIDEBAR_ACTIVITY_VIEW_KEY,
    SIDEBAR_ACTIVITY_VIEW_DEFAULT,
    Schema.Boolean,
  );
  return { activityActive, toggleActivity: () => setActivityActive((active) => !active) };
}

export function SidebarViewToggles(props: {
  readonly onBackdrop: boolean;
  readonly priorityCount: number;
}) {
  const { activityActive, toggleActivity } = useSidebarActivityToggle();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activityLabel = activityActive ? "Show projects" : "Show activity";
  const activityName =
    props.priorityCount > 0
      ? `${activityLabel}, ${props.priorityCount} in Priority`
      : activityLabel;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleActivity");

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={props.onBackdrop ? "media-navigation" : "ghost"}
              size="icon-sm"
              aria-label={activityName}
              aria-pressed={activityActive}
              data-pressed={activityActive ? "" : undefined}
              onClick={toggleActivity}
            >
              <BellIcon />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {activityName}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      {props.priorityCount > 0 ? (
        <span className="min-w-4 text-center text-xs text-muted-foreground tabular-nums">
          {props.priorityCount}
        </span>
      ) : null}
    </div>
  );
}
