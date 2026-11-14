import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "./ui/AppText";

/** Clamps tall content behind a "Show more" toggle; unfoldable content renders as is. */
export function FoldableContent(props: {
  readonly foldable: boolean;
  readonly foldedHeight: number;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="items-start gap-1">
      <View
        className="w-full overflow-hidden"
        style={props.foldable && !expanded ? { maxHeight: props.foldedHeight } : undefined}
      >
        {props.children}
      </View>
      {props.foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          className="active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
