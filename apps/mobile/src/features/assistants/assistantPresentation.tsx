import type {
  Assistant,
  AssistantSpend,
  AssistantToolAccess,
  AssistantWorkspace,
  BudgetPeriod,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  ASSISTANT_ICON_STROKE_WIDTH,
  ASSISTANT_ICON_VIEWBOX,
  assistantIconFor,
} from "@t3tools/client-runtime/assistantIcons";
import { assistantRobotLook, type AssistantMood } from "@t3tools/client-runtime/assistantRobot";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { useAssistantEntries } from "../../state/assistants";
import { useAssetUrlState } from "../../state/assets";
import { AssistantRobot } from "./AssistantRobot";

export const WORKSPACE_OPTIONS: ReadonlyArray<{
  readonly value: AssistantWorkspace;
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
}> = [
  {
    value: "host",
    label: "This Mac",
    description: "Commands and file edits run here, in the project.",
    icon: "laptopcomputer",
  },
  {
    value: "sandbox",
    label: "Sandbox container (Linux, Docker)",
    description: "Commands and file edits run in an isolated container; on this Mac it only reads.",
    icon: "cube",
  },
];

export const TOOL_ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: AssistantToolAccess;
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "Reads files and answers. It cannot change files or run commands that write.",
    icon: "eye",
  },
  {
    value: "workspace-write",
    label: "Edit files",
    description: "Edits files without asking. Commands and other actions still ask first.",
    icon: "pencil",
  },
  {
    value: "full",
    label: "Full access",
    description: "Runs commands and edits files without asking.",
    icon: "bolt.circle",
  },
];

/** The one line shown beside "Advanced" while it is closed. */
export function assistantAdvancedSummary(draft: {
  readonly toolAccess: AssistantToolAccess;
  readonly workspace: AssistantWorkspace;
  readonly budget: { readonly enabled: boolean; readonly amount: string };
  readonly connectors: ReadonlyArray<unknown>;
  readonly askBeforeActing: boolean;
}): string {
  const amount = draft.budget.amount.trim();
  return [
    toolAccessLabel(draft.toolAccess),
    draft.workspace === "host" ? "This Mac" : "Sandbox container",
    draft.budget.enabled
      ? amount === ""
        ? "spending limit"
        : `$${amount} limit`
      : "no spending limit",
    draft.connectors.length === 0
      ? "no connectors"
      : `${draft.connectors.length} connector${draft.connectors.length === 1 ? "" : "s"}`,
    draft.askBeforeActing ? "asks before messaging other threads" : "messages other threads freely",
  ].join(" · ");
}

export function toolAccessLabel(access: AssistantToolAccess): string {
  return TOOL_ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? access;
}

const ThemedSvg = withUniwind(Svg);

/** An assistant's icon stroked in `color` (or the themed `colorClassName`); null for none or an unknown id. */
export function AssistantIconGlyph(props: {
  readonly icon: string | null | undefined;
  readonly size: number;
  readonly color?: string;
  readonly colorClassName?: string;
}) {
  const definition = assistantIconFor(props.icon);
  if (definition === null) return null;
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${ASSISTANT_ICON_VIEWBOX} ${ASSISTANT_ICON_VIEWBOX}`}
      color={props.color}
      colorClassName={props.colorClassName}
      fill="none"
      stroke="currentColor"
      strokeWidth={ASSISTANT_ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {definition.paths.map((d) => (
        <Path key={d} d={d} />
      ))}
    </ThemedSvg>
  );
}

/** The uploaded picture, loaded through its signed URL; the robot shows until it arrives or if it fails. */
function AssistantImageAvatar(props: {
  readonly assistant: Pick<Assistant, "id" | "avatar" | "icon">;
  readonly revision: number;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly mood: AssistantMood | undefined;
  readonly size: number;
}) {
  const { assistant, size } = props;
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
    return <AssistantRobot look={assistantRobotLook(assistant)} mood={props.mood} size={size} />;
  }
  return (
    <Image
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      source={{ uri: asset.url }}
      contentFit="cover"
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
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
  readonly mood?: AssistantMood;
  readonly size?: number;
  /** Where the picture is served from; found from the assistant list when left out. */
  readonly environmentId?: EnvironmentId | null;
}) {
  const { assistant } = props;
  const size = props.size ?? 28;
  if (assistant.avatar?.kind === "image") {
    return (
      <AssistantImageAvatar
        assistant={assistant}
        revision={assistant.avatar.revision}
        environmentId={props.environmentId}
        mood={props.mood}
        size={size}
      />
    );
  }
  if (assistant.avatar === null && assistantIconFor(assistant.icon) !== null) {
    const hue = assistantRobotLook(assistant).hue;
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="items-center justify-center rounded-full"
        style={{ width: size, height: size, backgroundColor: `hsla(${hue}, 70%, 55%, 0.22)` }}
      >
        <AssistantIconGlyph
          icon={assistant.icon}
          size={size * 0.62}
          color={`hsl(${hue}, 60%, 45%)`}
        />
      </View>
    );
  }
  return <AssistantRobot look={assistantRobotLook(assistant)} mood={props.mood} size={size} />;
}

export const BUDGET_PERIOD_OPTIONS: ReadonlyArray<{
  readonly value: BudgetPeriod;
  readonly label: string;
  readonly icon: AppSymbolName;
}> = [
  { value: "daily", label: "Daily", icon: "sun.max" },
  { value: "weekly", label: "Weekly", icon: "clock" },
  { value: "monthly", label: "Monthly", icon: "calendar.badge.clock" },
];

const PERIOD_WORDS = { daily: "today", weekly: "this week", monthly: "this month" } as const;
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

/** "$1.23 this month · estimated at API prices"; the budget's period when it has one, else the last 30 days. */
export function budgetSpendLine(spend: AssistantSpend): string {
  const status = spend.budget;
  const amount = status ? status.spentUsd : spend.periodUsd;
  const when = status ? PERIOD_WORDS[status.period] : "in the last 30 days";
  const prefix = spend.partial ? "At least " : "";
  return `${prefix}${usd.format(amount)} ${when} · estimated at API prices`;
}
