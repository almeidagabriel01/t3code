import { taskEventActivitySegments } from "@t3tools/client-runtime/assistantTasks";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

// The project gives way first, then the title; the status and action never truncate. A chip
// (the All tab's only sign of the project) never shrinks below its own cap; the title truncates.
const SEGMENT_CLASS = {
  title: "min-w-0 shrink text-xs text-foreground-muted",
  label: "shrink-0 text-xs text-foreground-muted",
  project: "min-w-0 shrink-[999] text-xs text-foreground-muted",
} as const;
const CHIPPED_TITLE_CLASS = "min-w-10 shrink text-xs text-foreground-muted";

const STATUS_SYMBOL = {
  completed: { name: "checkmark.circle.fill", tint: "accent-adaptive-emerald-600-400" },
  failed: { name: "xmark.circle.fill", tint: "accent-danger-foreground" },
  cancelled: { name: "slash.circle", tint: "accent-foreground-muted" },
  interrupted: { name: "pause", tint: "accent-foreground-muted" },
  none: { name: "circle.dashed", tint: "accent-foreground-muted" },
} as const;

/** One compact, muted line for a finished task; the whole row opens the task. */
export function TaskEventActivityRow(props: {
  readonly title: string;
  readonly label: string;
  /** Where the task belongs, after the status; it truncates before the title does. */
  readonly project?: string | null;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted" | null;
  readonly onOpen: () => void;
  /** What the row opens, for screen readers. */
  readonly action?: string;
  /** Where the task belongs, such as its project, as a small pill after the status. */
  readonly chip?: { readonly label: string };
  readonly actionLabel?: string;
}) {
  const symbol = STATUS_SYMBOL[props.status ?? "none"];
  const segments = taskEventActivitySegments(props);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${[...segments.map((segment) => segment.text), ...(props.chip === undefined ? [] : [props.chip.label])].join(", ")}. ${props.action ?? "Open task"}`}
      onPress={props.onOpen}
      className="flex-row items-center gap-1.5 rounded-md px-1 py-1 active:bg-foreground/8"
    >
      <SymbolView
        name={symbol.name}
        size={13}
        weight="medium"
        tintColorClassName={symbol.tint}
        type="monochrome"
      />
      {segments.map((segment) => (
        <Text
          key={segment.kind}
          numberOfLines={1}
          className={
            segment.kind === "title" && props.chip !== undefined
              ? CHIPPED_TITLE_CLASS
              : SEGMENT_CLASS[segment.kind]
          }
        >
          {segment.separated ? `· ${segment.text}` : segment.text}
        </Text>
      ))}
      {props.chip === undefined ? null : (
        <View className="max-w-28 min-w-0 shrink-0 rounded-full bg-foreground/8 px-1.5 py-px">
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            className="text-2xs text-foreground-secondary"
          >
            {props.chip.label}
          </Text>
        </View>
      )}
      <Text className="ml-auto shrink-0 pl-2 font-t3-medium text-xs text-foreground-secondary">
        {props.actionLabel ?? "Open"}
      </Text>
    </Pressable>
  );
}
