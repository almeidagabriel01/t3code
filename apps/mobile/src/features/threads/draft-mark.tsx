import { View, type StyleProp, type ViewStyle } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { selectedThreadRowColors } from "./thread-list-v2-row-appearance";

export const DRAFT_MARK_LABEL = "Draft";

/** The pen a list row shows while its thread, assistant or group holds an unsent draft. */
export function DraftMark(props: {
  readonly selected?: boolean;
  /** Narrow rows keep the pen and drop the word. */
  readonly iconOnly?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const selected = props.selected === true;
  return (
    <View
      testID="draft-mark"
      accessibilityLabel={DRAFT_MARK_LABEL}
      className="shrink-0 flex-row items-center gap-1"
      style={props.style}
    >
      <SymbolView
        name="square.and.pencil"
        size={13}
        tintColorClassName={
          selected ? selectedThreadRowColors.iconTintClassName : "accent-adaptive-amber-700-300"
        }
        type="monochrome"
        weight="semibold"
      />
      {props.iconOnly === true ? null : (
        <Text
          className={cn(
            "text-xs font-t3-bold",
            selected ? selectedThreadRowColors.foregroundClassName : "text-adaptive-amber-700-300",
          )}
        >
          {DRAFT_MARK_LABEL}
        </Text>
      )}
    </View>
  );
}
