import type { ReactNode } from "react";
import { Pressable, type ColorValue, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { deriveThreadWorkLogSizing } from "../../lib/layout";
import { ThreadDisclosureChevron } from "./thread-work-log";

const TURN_FOLD_HEIGHT = 42;

export function WorkedForFold({
  label,
  expanded,
  loading,
  error,
  onToggle,
  rowSizing,
  iconColor,
  children,
}: {
  label: string;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  onToggle: () => void;
  rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  iconColor: ColorValue;
  children?: ReactNode;
}) {
  return (
    <View className="min-w-0 flex-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded, busy: loading }}
        onPress={onToggle}
        hitSlop={4}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
        style={{ minHeight: Math.max(TURN_FOLD_HEIGHT - 3.5, rowSizing.estimatedRowHeight) }}
      >
        <Text
          key={rowSizing.textSizeKey}
          numberOfLines={1}
          className="shrink font-t3-medium text-sm tabular-nums text-foreground-muted"
        >
          {label}
          {error ? ` · ${error}` : ""}
        </Text>
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={15}
          tintColor={iconColor}
        />
      </Pressable>
      {loading ? (
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          className="gap-2 px-1 pb-2"
        >
          {(["40%", "60%", "33%"] as const).map((width) => (
            <View key={width} className="flex-row items-center gap-2">
              <View className="size-3 rounded bg-subtle-strong" />
              <View className="h-2.5 rounded-full bg-subtle-strong" style={{ width }} />
            </View>
          ))}
        </View>
      ) : expanded ? (
        children
      ) : null}
    </View>
  );
}
