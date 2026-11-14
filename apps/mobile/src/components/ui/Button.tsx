import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { Pressable } from "react-native";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText } from "./AppText";
import { cn } from "../../lib/cn";

export interface ButtonProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
  readonly loading?: boolean;
  readonly tone?: "primary" | "secondary" | "danger" | "text" | "contrast";
  readonly fullWidth?: boolean;
  /** `tile`: icon above a one-line label that shrinks to fit, for equal-width action rows. */
  readonly size?: "default" | "compact" | "tile";
}

const TONE_CLASS_NAMES = {
  contrast: ["bg-foreground", "text-screen"],
  primary: ["bg-primary", "text-primary-foreground"],
  secondary: ["bg-secondary", "text-secondary-foreground"],
  danger: ["bg-danger", "text-danger-foreground"],
  text: ["bg-transparent", "text-primary-text"],
} as const;

export function Button(props: ButtonProps) {
  const [containerClassName, labelClassName] = TONE_CLASS_NAMES[props.tone ?? "secondary"];
  const disabled = Boolean(props.disabled || props.loading);
  const tile = props.size === "tile";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "items-center justify-center active:opacity-70",
        tile
          ? "min-h-16 gap-1 rounded-2xl px-2 py-2.5"
          : props.size === "compact"
            ? "min-h-10 flex-row gap-2 rounded-full px-5"
            : "min-h-12 flex-row gap-2 rounded-full px-6",
        props.fullWidth ? "w-full" : "self-start",
        disabled ? "bg-subtle-strong" : containerClassName,
      )}
    >
      {props.loading ? (
        <AppActivityIndicator colorClassName="accent-foreground-muted" />
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={
            disabled ? "accent-foreground-muted" : labelClassName.replace("text-", "accent-")
          }
        />
      ) : null}
      <AppText
        // Worst case, the 22pt app size with a 1.3x OS cap, shrinks "Group settings" to ~0.52x on a 360dp phone.
        {...(tile
          ? {
              textRole: "caption" as const,
              numberOfLines: 1,
              adjustsFontSizeToFit: true,
              minimumFontScale: 0.5,
              maxFontSizeMultiplier: 1.3,
            }
          : undefined)}
        className={cn(
          "min-w-0 shrink text-center font-t3-medium",
          tile && "self-stretch",
          disabled ? "text-foreground-muted" : labelClassName,
        )}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}
