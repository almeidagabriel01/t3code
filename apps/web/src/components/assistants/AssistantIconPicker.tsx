import type { AssistantIconId } from "@t3tools/contracts";
import { ASSISTANT_ICONS } from "@t3tools/client-runtime/assistantIcons";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";

import { cn } from "~/lib/utils";
import { AssistantIconGlyph } from "./assistantPresentation";

const NONE = "none";

const OPTION_CLASS =
  "inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-foreground/12 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-foreground/8 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-checked:border-primary data-checked:bg-primary/15";

/** One choice: an original icon, or "Initial" for none. */
export function AssistantIconPicker(props: {
  readonly value: AssistantIconId | null;
  readonly initial: string;
  readonly onChange: (icon: AssistantIconId | null) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">Icon</legend>
      <p className="text-xs text-muted-foreground">Shown instead of its initial.</p>
      <RadioGroup
        aria-label="Icon"
        className="flex flex-wrap gap-2"
        value={props.value ?? NONE}
        onValueChange={(value) =>
          props.onChange(value === NONE ? null : (value as AssistantIconId))
        }
      >
        <Radio.Root value={NONE} aria-label="Initial" className={OPTION_CLASS}>
          {props.initial}
        </Radio.Root>
        {ASSISTANT_ICONS.map((icon) => (
          <Radio.Root
            key={icon.id}
            value={icon.id}
            aria-label={icon.label}
            title={icon.label}
            className={cn(OPTION_CLASS)}
          >
            <AssistantIconGlyph icon={icon.id} className="size-5" />
          </Radio.Root>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
