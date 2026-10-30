import { formatDecisionExpiry } from "@t3tools/client-runtime/state/decisions";
import type { DecisionEntry } from "@t3tools/client-runtime/state/decisions";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useNowMinuteMs } from "../../lib/clock";
import { useThreadOpenDecisions } from "../../state/decisions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { DecisionCard } from "./DecisionCard";

/** The expanded card scrolls inside this height so the thread above it keeps its room. */
const EXPANDED_MAX_HEIGHT = 380;

/**
 * The thread's most urgent open decision: one row until the user reviews it, then the full card
 * in place. The rest wait on the Home list.
 */
export function ThreadDecisionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [first, ...rest] = useThreadOpenDecisions(props.environmentId, props.threadId);
  if (first === undefined) return null;
  return (
    <DecisionRow
      key={`${first.environmentId}:${first.decision.id}`}
      entry={first}
      more={rest.length}
    />
  );
}

function DecisionRow(props: { readonly entry: DecisionEntry; readonly more: number }) {
  const returnToList = useWorkspaceBackNavigation("threads");
  const nowMs = useNowMinuteMs();
  const [expanded, setExpanded] = useState(false);
  const { decision, environmentId } = props.entry;
  const expiry =
    decision.expiresAt === undefined ? null : formatDecisionExpiry(decision.expiresAt, nowMs);
  return (
    <View className="gap-2">
      {expanded ? (
        <ScrollView
          style={{ maxHeight: EXPANDED_MAX_HEIGHT }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <DecisionCard environmentId={environmentId} decision={decision} />
        </ScrollView>
      ) : null}
      <View className="flex-row items-center gap-3 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5">
        <SymbolView
          name="questionmark.bubble"
          size={16}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
            <Text className="text-foreground-muted">Decision needed: </Text>
            {decision.title}
          </Text>
          {expiry ? (
            <Text className="font-sans text-2xs text-foreground-muted">{expiry}</Text>
          ) : null}
        </View>
        <Button
          label={expanded ? "Hide" : "Review"}
          tone="primary"
          accessibilityHint={expanded ? "Collapses the decision" : "Opens the decision"}
          onPress={() => setExpanded((open) => !open)}
        />
      </View>
      {props.more > 0 ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={returnToList}
          className="min-h-10 justify-center self-start px-2 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            +{props.more} more {props.more === 1 ? "decision" : "decisions"} on Home
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
