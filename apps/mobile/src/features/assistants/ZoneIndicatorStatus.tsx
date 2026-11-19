import { type ZoneIndicator, zoneIndicatorLabel } from "@t3tools/client-runtime/sidebarZones";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

const ZONE_INDICATOR_LOOK = {
  needs: ["questionmark.bubble", "text-warning-foreground", "accent-warning-foreground"],
  running: ["circle.dashed", "text-adaptive-sky-600-400", "accent-adaptive-sky-600-400"],
  failed: ["exclamationmark.circle", "text-danger-foreground", "accent-danger-foreground"],
  limited: ["hourglass", "text-warning-foreground", "accent-warning-foreground"],
  paused: ["pause", "text-warning-foreground", "accent-warning-foreground"],
  unread: ["envelope.badge", "text-primary-text", "accent-primary"],
} as const satisfies Record<ZoneIndicator["kind"], readonly [AppSymbolName, string, string]>;

/** An assistant's or a group's one status, in the sidebar's words: its icon, then its label. */
export function ZoneIndicatorStatus(props: {
  readonly indicator: ZoneIndicator;
  readonly subject: "assistant" | "group";
  readonly testID: string;
}) {
  const [icon, textClass, tintClass] = ZONE_INDICATOR_LOOK[props.indicator.kind];
  const label = zoneIndicatorLabel(props.indicator, props.subject);
  return (
    <View testID={props.testID} accessibilityLabel={label} className="flex-row items-center gap-1">
      <SymbolView
        name={icon}
        size={13}
        tintColorClassName={tintClass}
        type="monochrome"
        weight="semibold"
      />
      <Text className={cn("text-xs font-t3-bold", textClass)} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
