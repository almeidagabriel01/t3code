import type { AssistantGroupTab } from "@t3tools/client-runtime/assistantGroupChat";
import { useRef } from "react";
import { Platform, ScrollView, View, type ScrollViewInstance } from "react-native";

import { Chip } from "../../components/ui/Chip";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useBarInset } from "../../components/ui/useBarInset";

/**
 * The group chat's project tabs. Takes everything as props and reads no route, so the tablet
 * sidebar can open the chat by id. iOS pins it on glass under the transparent bar and reports its
 * height for the list's inset; Android draws it in flow under the bar.
 */
export function GroupProjectTabs(props: {
  readonly tabs: ReadonlyArray<AssistantGroupTab>;
  readonly activeKey: string;
  readonly onSelect: (tab: AssistantGroupTab) => void;
  readonly onHeight: (height: number) => void;
}) {
  const barInset = useBarInset();
  const scroll = useRef<ScrollViewInstance>(null);
  const row = (
    <View testID="group-tabs" role="group" accessibilityLabel="Project tabs">
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-2 px-4 py-1.5">
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
  if (Platform.OS !== "ios") return row;
  return (
    <GlassSurface
      testID="group-tabs-glass"
      chrome="none"
      style={{ position: "absolute", top: barInset, left: 0, right: 0, borderRadius: 0 }}
      onLayout={({ nativeEvent }) => props.onHeight(nativeEvent.layout.height)}
    >
      {row}
    </GlassSurface>
  );
}
