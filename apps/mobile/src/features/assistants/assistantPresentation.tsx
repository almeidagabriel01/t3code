import type {
  Assistant,
  AssistantSpend,
  AssistantToolAccess,
  AssistantWorkspace,
  BudgetPeriod,
} from "@t3tools/contracts";
import {
  ASSISTANT_ICON_STROKE_WIDTH,
  ASSISTANT_ICON_VIEWBOX,
  assistantIconFor,
} from "@t3tools/client-runtime/assistantIcons";
import { assistantInitial } from "@t3tools/client-runtime/assistantPresence";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";

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

function hueOf(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/** The assistant's initial on a tint taken from its handle, so each reads as itself. */
export function AssistantAvatar(props: {
  readonly assistant: Pick<Assistant, "name" | "handle" | "icon">;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const hue = hueOf(props.assistant.handle);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: `hsla(${hue}, 70%, 55%, 0.22)`,
      }}
    >
      {assistantIconFor(props.assistant.icon) ? (
        <AssistantIconGlyph
          icon={props.assistant.icon}
          size={size * 0.62}
          color={`hsl(${hue}, 60%, 45%)`}
        />
      ) : (
        <Text
          className="font-t3-bold"
          style={{ fontSize: size * 0.46, color: `hsl(${hue}, 60%, 45%)` }}
        >
          {assistantInitial(props.assistant.name)}
        </Text>
      )}
    </View>
  );
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
