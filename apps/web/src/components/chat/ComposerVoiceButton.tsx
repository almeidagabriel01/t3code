import { MicIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ComposerVoiceButtonProps {
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export function ComposerVoiceButton({ disabled, onClick }: ComposerVoiceButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label="Dictate"
            // Keep the caret in the editor so the transcript lands where the user was typing.
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
          />
        }
      >
        <MicIcon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>Dictate</TooltipPopup>
    </Tooltip>
  );
}
