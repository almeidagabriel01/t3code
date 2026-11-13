import type { Assistant, AssistantToolAccess, EnvironmentId } from "@t3tools/contracts";
import { LockIcon, PenLineIcon, ShieldOffIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  ASSISTANT_ICON_STROKE_WIDTH,
  ASSISTANT_ICON_VIEWBOX,
  assistantIconFor,
} from "@t3tools/client-runtime/assistantIcons";
import type { AssistantAttention } from "@t3tools/client-runtime/assistantList";
import { ASSISTANT_GROUP_STATUS_LABEL } from "@t3tools/client-runtime/assistantGroupChat";
import { assistantAccent, assistantInitial } from "@t3tools/client-runtime/assistantPresence";
import {
  assistantRobotLook,
  type AssistantFace,
  type AssistantMood,
} from "@t3tools/client-runtime/assistantRobot";
import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { useAssistantEntries } from "~/state/assistants";
import {
  resolveSidebarTopStatus,
  TopStatusIcon,
  type SidebarTopStatus,
} from "../sidebar/sidebarTopStatus";
import { AssistantRobot } from "./AssistantRobot";

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
function AssistantIconGlyph(props: {
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

/** The uploaded picture, loaded through its signed URL; the robot shows until it arrives or if it fails. */
function AssistantImageAvatar(props: {
  readonly assistant: Pick<Assistant, "id" | "avatar" | "icon">;
  readonly revision: number;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly mood: AssistantMood | AssistantFace | undefined;
  readonly animated: boolean | undefined;
  readonly className: string | undefined;
}) {
  const { assistant } = props;
  const entries = useAssistantEntries();
  const environmentId =
    props.environmentId ??
    [...entries.active, ...entries.archived].find((entry) => entry.assistant.id === assistant.id)
      ?.environmentId ??
    null;
  const asset = useAssetUrlState(
    environmentId,
    { _tag: "assistant-avatar", assistantId: assistant.id },
    String(props.revision),
  );
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (asset._tag !== "Success" || asset.url === failedUrl) {
    return (
      <AssistantRobot
        look={assistantRobotLook(assistant)}
        {...(props.mood === undefined ? {} : { mood: props.mood })}
        {...(props.animated === undefined ? {} : { animated: props.animated })}
        className={cn("size-5", props.className)}
      />
    );
  }
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={asset.url}
      data-assistant-avatar-image=""
      className={cn("size-5 shrink-0 object-cover", props.className)}
      style={{ borderRadius: "28%" }}
      onError={() => setFailedUrl(asset.url)}
    />
  );
}

/**
 * The assistant's picture, its robot, or the icon it chose before robots existed. The robot's face
 * follows `mood`, so a row shows at a glance whether it works, waits on the user or failed.
 */
export function AssistantAvatar(props: {
  readonly assistant: Pick<Assistant, "id" | "avatar" | "icon">;
  readonly mood?: AssistantMood | AssistantFace;
  /** Play the robot's sparse motion; only for avatars of 24px and up. */
  readonly animated?: boolean;
  readonly className?: string;
  /** Where the picture is served from; found from the assistant list when left out. */
  readonly environmentId?: EnvironmentId | null;
}) {
  const { assistant } = props;
  if (assistant.avatar?.kind === "image") {
    return (
      <AssistantImageAvatar
        assistant={assistant}
        revision={assistant.avatar.revision}
        environmentId={props.environmentId}
        mood={props.mood}
        animated={props.animated}
        className={props.className}
      />
    );
  }
  if (assistant.avatar === null && assistantIconFor(assistant.icon) !== null) {
    const hue = assistantRobotLook(assistant).hue;
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
          props.className,
        )}
        style={{
          backgroundColor: `oklch(0.72 0.12 ${hue} / 0.28)`,
          color: `light-dark(oklch(0.45 0.15 ${hue}), oklch(0.84 0.11 ${hue}))`,
        }}
      >
        <AssistantIconGlyph icon={assistant.icon} />
      </span>
    );
  }
  return (
    <AssistantRobot
      look={assistantRobotLook(assistant)}
      {...(props.mood === undefined ? {} : { mood: props.mood })}
      {...(props.animated === undefined ? {} : { animated: props.animated })}
      className={cn("size-5", props.className)}
    />
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

/** An assistant's or a group's state in the words and colors a thread row uses for the same state. */
function assistantTopStatus(attention: AssistantAttention): SidebarTopStatus {
  if (attention === "paused") {
    // A task stopped at a limit waits on the user like a question does; the label is the chat's own.
    return {
      label: ASSISTANT_GROUP_STATUS_LABEL.paused,
      icon: "waiting",
      className: "text-warning-foreground",
    };
  }
  return resolveSidebarTopStatus({
    status: attention === "decision" || attention === "done" ? "ready" : attention,
    hasOpenDecision: attention === "decision",
    isWoke: false,
    isUnread: attention === "done",
  })!;
}

/** An assistant's or a group's status in a thread row's words: its icon, then its label. */
export function AssistantAttentionStatus(props: {
  readonly attention: AssistantAttention;
  /** Hides the label, for instance in a narrow row. */
  readonly labelClassName?: string;
  readonly testId?: string;
}) {
  const status = assistantTopStatus(props.attention);
  return (
    <span
      data-testid={props.testId ?? "assistant-status"}
      data-status={props.attention}
      aria-label={status.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
        status.className,
      )}
    >
      <TopStatusIcon icon={status.icon} className="size-3" />
      <span aria-hidden className={props.labelClassName}>
        {status.label}
      </span>
    </span>
  );
}
