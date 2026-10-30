import type { Assistant, AssistantToolAccess } from "@t3tools/contracts";
import { LockIcon, PenLineIcon, ShieldOffIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export const TOOL_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: AssistantToolAccess;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "Reads files and answers. It cannot change files or run commands that write.",
    icon: LockIcon,
  },
  {
    value: "workspace-write",
    label: "Edit files",
    description: "Edits files without asking. Commands and other actions still ask first.",
    icon: PenLineIcon,
  },
  {
    value: "full",
    label: "Full access",
    description: "Runs commands and edits files without asking.",
    icon: ShieldOffIcon,
  },
];

export function toolAccessLabel(access: AssistantToolAccess): string {
  return TOOL_ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? access;
}

function hueOf(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** The assistant's initial on a tint taken from its handle, so each reads as itself. */
export function AssistantAvatar(props: {
  readonly assistant: Pick<Assistant, "name" | "handle">;
  readonly className?: string;
}) {
  const hue = hueOf(props.assistant.handle);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-2xs leading-none font-semibold",
        props.className,
      )}
      style={{
        backgroundColor: `oklch(0.72 0.12 ${hue} / 0.28)`,
        color: `oklch(0.62 0.16 ${hue})`,
      }}
    >
      {props.assistant.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
