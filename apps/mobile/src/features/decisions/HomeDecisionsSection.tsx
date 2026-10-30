import type { DecisionEntry } from "@t3tools/client-runtime/state/decisions";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useDecisionEntries } from "../../state/decisions";
import { DecisionCard } from "./DecisionCard";

/** Open decisions as cards, most urgent first, then a folded list of how recent ones ended. */
export function HomeDecisionsSection(props: {
  readonly gutter: number;
  readonly onOpenThread: (entry: DecisionEntry) => void;
}) {
  const { open, settled } = useDecisionEntries();
  const [recentOpen, setRecentOpen] = useState(false);
  if (open.length === 0 && settled.length === 0) return null;
  return (
    <View className="gap-3 pb-3 pt-2" style={{ paddingHorizontal: props.gutter }}>
      {open.length > 0 ? (
        <>
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            Decisions · {open.length}
          </Text>
          {open.map((entry) => (
            <DecisionCard
              key={`${entry.environmentId}:${entry.decision.id}`}
              environmentId={entry.environmentId}
              decision={entry.decision}
              onOpenThread={() => props.onOpenThread(entry)}
            />
          ))}
        </>
      ) : null}
      {settled.length > 0 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: recentOpen }}
            hitSlop={8}
            onPress={() => setRecentOpen((value) => !value)}
            className="min-h-10 flex-row items-center gap-1.5 active:opacity-70"
          >
            <SymbolView
              name={recentOpen ? "chevron.down" : "chevron.right"}
              size={12}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
            <Text className="font-t3-medium text-xs text-foreground-secondary">
              Recent decisions ({settled.length})
            </Text>
          </Pressable>
          {recentOpen
            ? settled.map((entry) => (
                <DecisionCard
                  key={`${entry.environmentId}:${entry.decision.id}`}
                  environmentId={entry.environmentId}
                  decision={entry.decision}
                  onOpenThread={() => props.onOpenThread(entry)}
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}
