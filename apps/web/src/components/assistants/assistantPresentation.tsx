import type { Assistant, AssistantToolAccess, EnvironmentId } from "@t3tools/contracts";
import { LockIcon, PenLineIcon, ShieldOffIcon, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  ASSISTANT_ICON_STROKE_WIDTH,
  ASSISTANT_ICON_VIEWBOX,
  assistantIconFor,
} from "@t3tools/client-runtime/assistantIcons";
import {
  assistantClusterLayout,
  type AssistantClusterCell,
} from "@t3tools/client-runtime/assistantCluster";
import {
  assistantQueuedLabel,
  assistantRobotLook,
  type AssistantFace,
  type AssistantMood,
  type AssistantPresence,
} from "@t3tools/client-runtime/assistantRobot";
import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { useAssistantEntries } from "~/state/assistants";
import { formatRelativeTimeLabel } from "~/timestampFormat";
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

/** The color a status line takes for each mood. */
export const MOOD_TEXT: Record<AssistantMood, string> = {
  idle: "text-muted-foreground",
  working: "text-info-foreground",
  needs: "text-warning-foreground",
  failed: "text-destructive-foreground",
};

/** "Working in Leadership · 3m ago · 2 queued": the one status line a card or info hero shows. */
export function assistantStatusText(presence: AssistantPresence, nowMs: number): string {
  const since = presence.since === null ? "" : formatRelativeTimeLabel(presence.since, nowMs);
  return [presence.detail, since, assistantQueuedLabel(presence.queued)]
    .filter((part) => part !== "" && part !== null)
    .join(" · ");
}

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

/** A sender or member whose assistant was deleted: a robot derived from its id alone. */
export const removedAssistantFace = (id: string): Pick<Assistant, "id" | "avatar" | "icon"> => ({
  id: id as Assistant["id"],
  avatar: null,
  icon: null,
});

/**
 * A group's faces in one square: one fills it, two sit side by side, three form a triangle, four
 * a 2×2 grid; five or more show three faces and "+N". The frame's size comes from `className`.
 */
export function AssistantCluster(props: {
  readonly faces: ReadonlyArray<{
    readonly key: string;
    readonly assistant: Pick<Assistant, "id" | "avatar" | "icon">;
    readonly mood?: AssistantMood | AssistantFace;
  }>;
  readonly environmentId?: EnvironmentId | null;
  readonly className?: string;
}) {
  const layout = assistantClusterLayout(props.faces.length);
  const place = (cell: AssistantClusterCell) => ({
    left: `${cell.left}%`,
    top: `${cell.top}%`,
    width: `${cell.size}%`,
    height: `${cell.size}%`,
  });
  return (
    <span
      aria-hidden
      data-assistant-cluster={props.faces.length}
      className={cn("@container relative inline-block size-5 shrink-0", props.className)}
    >
      {layout.faces.map((cell, index) => {
        const face = props.faces[index]!;
        return (
          <span key={face.key} className="absolute" style={place(cell)}>
            <AssistantAvatar
              assistant={face.assistant}
              environmentId={props.environmentId ?? null}
              {...(face.mood === undefined ? {} : { mood: face.mood })}
              className="size-full"
            />
          </span>
        );
      })}
      {layout.more ? (
        <span
          data-assistant-cluster-more
          className="absolute flex items-center justify-center rounded-full bg-foreground/12 leading-none font-semibold text-foreground tabular-nums"
          style={{ ...place(layout.more.cell), fontSize: "clamp(6px, 22cqw, 11px)" }}
        >
          +{layout.more.count}
        </span>
      ) : null}
    </span>
  );
}
