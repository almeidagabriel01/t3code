import type { IntegrationTone } from "@t3tools/client-runtime/integrations";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

const TONE_CLASS: Readonly<Record<IntegrationTone, string>> = {
  success: "border-border text-success-foreground",
  warning: "border-warning-border bg-warning text-warning-foreground",
  danger: "border-danger-border bg-danger text-danger-foreground",
  muted: "border-border text-foreground-muted",
  progress: "border-border text-foreground-muted",
};

/** A status or origin label; warning and danger carry a tinted fill so they read in both themes. */
export function IntegrationChip(props: { readonly label: string; readonly tone: IntegrationTone }) {
  const tone = TONE_CLASS[props.tone];
  return (
    <View className={cn("max-w-full self-start rounded-md border px-1.5 py-px", tone)}>
      <Text className={cn("text-2xs", tone)} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

/** Catalog icons are one 24×24 path; a light tile keeps dark brand colors visible in dark mode. */
export function IntegrationIcon(props: {
  readonly icon: { readonly svg: string; readonly color: string } | null;
}) {
  return props.icon === null ? (
    <View className="size-9 items-center justify-center rounded-lg bg-subtle">
      <SymbolView
        name="cable.connector"
        size={18}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </View>
  ) : (
    <View className="size-9 items-center justify-center rounded-lg border border-border bg-white">
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d={props.icon.svg} fill={props.icon.color} />
      </Svg>
    </View>
  );
}
