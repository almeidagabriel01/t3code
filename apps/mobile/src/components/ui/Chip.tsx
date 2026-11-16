import { GlassView } from "expo-glass-effect";
import { Pressable, View } from "react-native";
import { withUniwind } from "uniwind";

import { cn } from "../../lib/cn";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

const ChipGlass = withUniwind(GlassView, {
  style: { fromClassName: "className" },
  tintColor: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
});

export function Chip(props: {
  readonly label: string;
  readonly selected?: boolean;
  readonly icon?: AppSymbolName;
  readonly trailingIcon?: AppSymbolName;
  readonly size?: "small" | "default";
  readonly glass?: boolean;
  readonly colorScheme?: "light" | "dark";
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  /** Unread or pending items, drawn after the label when above zero. */
  readonly count?: number;
  /** Something waits on the user here. */
  readonly attention?: boolean;
}) {
  const count = props.count ?? 0;
  const small = props.size === "small";
  const layout = cn(
    "flex-row items-center gap-1.5 rounded-2xl px-3",
    small ? "py-1" : "min-h-8 py-1.5",
  );
  const iconColor = props.selected ? "accent-primary-foreground" : "accent-icon-muted";
  const content = (
    <>
      {props.icon ? (
        <SymbolView name={props.icon} size={15} tintColorClassName={iconColor} />
      ) : null}
      <AppText
        textRole={small ? "caption" : "footnote"}
        numberOfLines={small ? undefined : 1}
        className={cn(
          "shrink",
          !small && "max-w-[180px]",
          !small && "font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </AppText>
      {count > 0 ? (
        <AppText
          textRole={small ? "caption" : "footnote"}
          className={cn(
            "font-t3-medium tabular-nums",
            props.selected ? "text-primary-foreground" : "text-foreground",
          )}
        >
          {count}
        </AppText>
      ) : null}
      {props.attention ? (
        <View
          testID="chip-attention"
          accessibilityLabel="Waiting on you"
          className="size-1.5 rounded-full bg-warning-foreground"
        />
      ) : null}
      {props.trailingIcon ? (
        <SymbolView name={props.trailingIcon} size={11} tintColorClassName={iconColor} />
      ) : null}
    </>
  );
  const body =
    props.glass && NATIVE_LIQUID_GLASS_SUPPORTED ? (
      <ChipGlass
        isInteractive
        colorScheme={props.colorScheme}
        tintColorClassName={props.selected ? "accent-primary" : undefined}
        className={layout}
      >
        {content}
      </ChipGlass>
    ) : (
      <View
        className={cn(
          layout,
          props.selected ? "bg-primary" : small ? "bg-grouped-card" : "bg-subtle",
        )}
      >
        {content}
      </View>
    );
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      // A pressable reads as one element, so its label carries the count and the dot.
      accessibilityLabel={[
        props.accessibilityLabel ?? props.label,
        count > 0 ? `${count} unread` : null,
        props.attention ? "Waiting on you" : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      accessibilityState={{ selected: props.selected, disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={6}
      className={props.disabled ? "opacity-45" : "active:opacity-70"}
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}
