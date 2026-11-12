import { useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withTiming,
} from "react-native-reanimated";

import { segmentedControlColors } from "./segmentedControlColors";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme, colors, themeId } = useControlTheme();
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { width } = layout;
  const reduceMotion = useReducedMotion();
  const selectedIndex = props.options.findIndex((option) => option.value === props.selected);
  const segmentWidth = props.options.length ? Math.max(0, width - 6) / props.options.length : 0;
  const direction = I18nManager.isRTL ? -1 : 1;
  // The index animates, not the offset, so a resize moves the selection without sliding it.
  const selectedPosition = useDerivedValue(() =>
    withTiming(selectedIndex, { duration: reduceMotion ? 0 : 160 }),
  );
  const selectionStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: selectedPosition.value * segmentWidth * direction }],
  }));
  const { trackColor, selectedColor, selectedTextColor, mutedColor } = segmentedControlColors(
    colors,
    colorScheme,
    props.variant,
    Platform.OS,
    themeId,
  );
  const withIcons = props.options.some((option) => option.icon !== undefined);
  const minHeight = withIcons
    ? 52
    : props.size === "compact"
      ? 32
      : Platform.OS === "android"
        ? 40
        : 36;
  const shape = withIcons ? "rounded-2xl" : "rounded-full";
  const segmentShape = withIcons ? "rounded-[13px]" : "rounded-full";

  return (
    <View collapsable={false} className={props.className}>
      <View
        onLayout={(event) => setLayout(event.nativeEvent.layout)}
        className={`flex-row p-[3px] ${shape}`}
        style={{
          minHeight,
          backgroundColor: trackColor,
        }}
      >
        {selectedIndex >= 0 && width > 0 ? (
          <Animated.View
            pointerEvents="none"
            className={`absolute bottom-[3px] start-[3px] top-[3px] ${segmentShape}`}
            style={[
              {
                backgroundColor: selectedColor,
              },
              selectionStyle,
            ]}
          />
        ) : null}
        {props.options.map((option) => {
          const selected = option.value === props.selected;
          return (
            <Pressable
              key={`${typeof option.value}:${option.value}`}
              accessibilityRole={props.role ?? "button"}
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(option.value)}
              className={`min-w-0 flex-1 items-center justify-center px-1 py-1 active:opacity-70 ${segmentShape} ${withIcons ? "gap-0.5" : ""}`}
              style={{ minHeight: minHeight - 6 }}
            >
              {option.icon ? (
                <SymbolView
                  name={option.icon}
                  size={17}
                  tintColor={selected ? selectedTextColor : mutedColor}
                  type="monochrome"
                />
              ) : null}
              <AppText
                textRole={withIcons ? "caption" : "footnote"}
                numberOfLines={1}
                // Icon tabs keep one weight: a bolder selected label is wider and truncates in a tight row.
                className={selected && !withIcons ? "font-t3-bold" : "font-t3-medium"}
                style={{
                  color: selected ? selectedTextColor : mutedColor,
                }}
              >
                {option.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
