import { Pressable } from "react-native";

import { AppText as Text } from "./AppText";
import type { AppBarTitlePress } from "./AppBar.types";

/** A bar title that opens something, such as an assistant's info. */
export function AppBarTitleButton(props: AppBarTitlePress & { readonly title: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      hitSlop={8}
      onPress={props.onPress}
      className="max-w-full shrink flex-row items-center gap-2 active:opacity-60"
    >
      {props.leading}
      <Text className="shrink font-t3-bold text-[17px] text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
    </Pressable>
  );
}
