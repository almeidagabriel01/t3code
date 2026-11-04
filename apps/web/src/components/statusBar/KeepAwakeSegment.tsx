import { useNavigate } from "@tanstack/react-router";
import { CoffeeIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useKeepAwakeStatus } from "../../state/keepAwake";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isStatusBarItemShown, STATUS_BAR_KEEP_AWAKE_ITEM } from "./statusBarItems.logic";

function KeepAwakeSegmentBody() {
  const navigate = useNavigate();
  const active = useKeepAwakeStatus(usePrimaryEnvironmentId())?.active === true;
  if (!active) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label="Keeping this computer awake"
            onClick={() => void navigate({ to: "/settings/maintenance", hash: "keep-awake" })}
          >
            <CoffeeIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">Keeping this computer awake</TooltipPopup>
    </Tooltip>
  );
}

/** Shown only while the host really is being held awake. */
export function KeepAwakeSegment() {
  const hidden = useClientSettings((settings) => settings.statusBarHiddenItems);
  return isStatusBarItemShown(hidden, STATUS_BAR_KEEP_AWAKE_ITEM) ? <KeepAwakeSegmentBody /> : null;
}
