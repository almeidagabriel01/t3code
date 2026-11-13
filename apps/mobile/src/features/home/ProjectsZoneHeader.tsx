import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { UnreadActionsMenu } from "./UnreadActionsMenu";

/** The Projects zone's title, styled like Teams, with the read actions Activity has on web. */
export function ProjectsZoneHeader(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
  readonly gutter: number;
  readonly sidebar?: boolean;
}) {
  return (
    <View className="flex-row items-center pt-2" style={{ paddingHorizontal: props.gutter }}>
      <Text
        accessibilityRole="header"
        className={cn(
          "font-t3-bold text-2xs uppercase tracking-[1.1px]",
          props.sidebar ? "text-drawer-foreground-muted" : "text-foreground-secondary",
        )}
      >
        Projects
      </Text>
      <View className="flex-1" />
      <UnreadActionsMenu threads={props.threads} now={props.now} sidebar={props.sidebar} />
    </View>
  );
}
