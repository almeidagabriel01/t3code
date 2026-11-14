import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

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
  readonly status: "completed" | "failed" | "cancelled" | "interrupted" | null;
  readonly onOpen: () => void;
}) {
  const symbol = STATUS_SYMBOL[props.status ?? "none"];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.title}, ${props.label}. Open task`}
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
      <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
        {props.title}
      </Text>
      <Text numberOfLines={1} className="shrink-0 text-xs text-foreground-muted">
        {`· ${props.label}`}
      </Text>
      <Text className="shrink-0 font-t3-medium text-xs text-foreground-secondary">Open</Text>
    </Pressable>
  );
}
