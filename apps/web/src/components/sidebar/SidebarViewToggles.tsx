import { useAtomValue } from "@effect/atom-react";
import { BellIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useActivityBadge, useActivityOpen, useToggleActivity } from "../activity/useActivity";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarViewToggles(props: { readonly onBackdrop: boolean }) {
  const open = useActivityOpen();
  const toggleActivity = useToggleActivity();
  const count = useActivityBadge();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = open ? "Close activity" : "Open activity";
  const name = count > 0 ? `${label}, ${count} need attention` : label;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleActivity");

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={props.onBackdrop ? "media-navigation" : "ghost"}
              size="icon-sm"
              // media-navigation is absolutely placed for the sidebar trigger; the bell sits in the row.
              className="relative top-auto translate-y-0"
              aria-label={name}
              aria-pressed={open}
              data-pressed={open ? "" : undefined}
              onClick={toggleActivity}
            >
              <BellIcon />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {label}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      {count > 0 ? (
        <span className="min-w-4 text-center text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      ) : null}
    </div>
  );
}
