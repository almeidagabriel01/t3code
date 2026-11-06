import type { Assistant, AssistantToolAccess } from "@t3tools/contracts";
import { LockIcon, PenLineIcon, ShieldOffIcon, type LucideIcon } from "lucide-react";

import {
  ASSISTANT_ICON_STROKE_WIDTH,
  ASSISTANT_ICON_VIEWBOX,
  assistantIconFor,
} from "@t3tools/client-runtime/assistantIcons";
import { assistantAccent, assistantInitial } from "@t3tools/client-runtime/assistantPresence";
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

/** The assistant's icon in the current text color; null when it has none or the id is unknown. */
export function AssistantIconGlyph(props: {
  readonly icon: string | null | undefined;
  readonly className?: string;
}) {
  const definition = assistantIconFor(props.icon);
  if (definition === null) return null;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${ASSISTANT_ICON_VIEWBOX} ${ASSISTANT_ICON_VIEWBOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ASSISTANT_ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-assistant-icon={definition.id}
      className={cn("size-[62%]", props.className)}
    >
      {definition.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function hueOf(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** The assistant's initial on a tint taken from its handle, so each reads as itself. */
export function AssistantAvatar(props: {
  readonly assistant: Pick<Assistant, "name" | "handle" | "icon">;
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
        color: `light-dark(oklch(0.45 0.15 ${hue}), oklch(0.84 0.11 ${hue}))`,
      }}
    >
      <AssistantIconGlyph icon={props.assistant.icon} />
      {assistantIconFor(props.assistant.icon) ? null : assistantInitial(props.assistant.name)}
    </span>
  );
}

/** The assistant's initial on its accent color, the same on every client and in every thread. */
export function AssistantAccentAvatar(props: {
  readonly assistantId: string;
  readonly name: string;
  readonly icon?: string | null | undefined;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs leading-none font-semibold text-white",
        props.className,
      )}
      style={{ backgroundColor: assistantAccent(props.assistantId) }}
    >
      <AssistantIconGlyph icon={props.icon} />
      {assistantIconFor(props.icon) ? null : assistantInitial(props.name)}
    </span>
  );
}
