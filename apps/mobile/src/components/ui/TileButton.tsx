import { Pressable } from "react-native";

import { cn } from "../../lib/cn";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText } from "./AppText";

/**
 * Icon above a one-line label that shrinks to fit, for equal-width action rows. Drawn the same on
 * iOS and Android: the Compose `Button` has no layout for it.
 */
export function TileButton(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-16 w-full items-center justify-center gap-1 rounded-2xl px-2 py-2.5 active:opacity-70",
        props.disabled ? "bg-subtle-strong" : "bg-secondary",
      )}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName={
          props.disabled ? "accent-foreground-muted" : "accent-secondary-foreground"
        }
      />
      <AppText
        // Worst case, the 22pt app size with a 1.3x OS cap, shrinks "Group settings" to ~0.52x on a 360dp phone.
        textRole="caption"
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
        maxFontSizeMultiplier={1.3}
        className={cn(
          "min-w-0 self-stretch text-center font-t3-medium",
          props.disabled ? "text-foreground-muted" : "text-secondary-foreground",
        )}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}
