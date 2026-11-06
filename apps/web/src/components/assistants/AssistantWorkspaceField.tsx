import type { AssistantWorkspace, EnvironmentId } from "@t3tools/contracts";
import { assistantSandboxView } from "@t3tools/client-runtime/state/assistants";
import { BoxIcon, LaptopIcon, type LucideIcon } from "lucide-react";

import { useAssistantSandbox } from "../../state/assistants";
import { Radio, RadioGroup } from "../ui/radio-group";

const OPTIONS: ReadonlyArray<{
  readonly value: AssistantWorkspace;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    value: "host",
    label: "This Mac",
    description: "Commands and file edits run here, in the project.",
    icon: LaptopIcon,
  },
  {
    value: "sandbox",
    label: "Sandbox container (Linux, Docker)",
    description: "Commands and file edits run in an isolated container; on this Mac it only reads.",
    icon: BoxIcon,
  },
];

/** Where the assistant works. The sandbox needs Docker on the server's machine, and says so when it is missing. */
export function AssistantWorkspaceField(props: {
  readonly environmentId: EnvironmentId | null;
  readonly value: AssistantWorkspace;
  readonly onChange: (value: AssistantWorkspace) => void;
}) {
  const unavailable = assistantSandboxView(
    useAssistantSandbox(props.environmentId),
  ).unavailableReason;
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">Workspace</legend>
      <p className="text-xs text-muted-foreground">
        Where it runs commands and edits files. Its tool access applies there.
      </p>
      <RadioGroup
        aria-label="Workspace"
        value={props.value}
        onValueChange={(value) => props.onChange(value as AssistantWorkspace)}
      >
        {OPTIONS.map((option) => {
          const disabled = option.value === "sandbox" && unavailable !== null;
          return (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 outline-hidden hover:bg-foreground/8 has-data-disabled:cursor-not-allowed has-data-disabled:hover:bg-transparent"
            >
              <Radio value={option.value} disabled={disabled} className="mt-0.5" />
              <option.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm">{option.label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {disabled ? unavailable : option.description}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}
