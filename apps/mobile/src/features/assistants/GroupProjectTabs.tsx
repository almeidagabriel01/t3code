import type { AssistantGroupTab } from "@t3tools/client-runtime/assistantGroupChat";
import { type ReactNode, useRef } from "react";
import { Platform, ScrollView, View, type ScrollViewInstance } from "react-native";

import { Chip } from "../../components/ui/Chip";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useBarInset } from "../../components/ui/useBarInset";

/**
 * The group chat's project tabs. Takes everything as props and reads no route, so the tablet
 * sidebar can open the chat by id.
 */
export function GroupProjectTabs(props: {
  readonly tabs: ReadonlyArray<AssistantGroupTab>;
  readonly activeKey: string;
  readonly onSelect: (tab: AssistantGroupTab) => void;
}) {
  const scroll = useRef<ScrollViewInstance>(null);
  return (
    <View testID="group-tabs" role="group" accessibilityLabel="Project tabs">
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-2 px-4">
          {props.tabs.map((tab) => (
            <View
              key={tab.key}
              onLayout={
                tab.key === props.activeKey
                  ? ({ nativeEvent }) =>
                      scroll.current?.scrollTo({
                        x: Math.max(0, nativeEvent.layout.x - 16),
                        animated: false,
                      })
                  : undefined
              }
            >
              <Chip
                glass
                label={tab.label}
                selected={tab.key === props.activeKey}
                count={tab.unreadCount}
                attention={tab.waiting}
                onPress={() => props.onSelect(tab)}
              />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * The rows under the group chat's bar: tabs and who works on what. iOS pins them on glass under
 * the transparent bar and reports their height for the list's inset; Android draws them in flow.
 */
export function GroupPinnedRows(props: {
  readonly children: ReactNode;
  readonly onHeight: (height: number) => void;
}) {
  const barInset = useBarInset();
  const rows = <View className="gap-1.5 py-1.5">{props.children}</View>;
  if (Platform.OS !== "ios") return rows;
  return (
    <GlassSurface
      testID="group-pinned-rows"
      chrome="none"
      style={{ position: "absolute", top: barInset, left: 0, right: 0, borderRadius: 0 }}
      onLayout={({ nativeEvent }) => props.onHeight(nativeEvent.layout.height)}
    >
      {rows}
    </GlassSurface>
  );
}
