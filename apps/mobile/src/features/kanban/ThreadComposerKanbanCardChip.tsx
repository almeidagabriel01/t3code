import { useAtom } from "@effect/atom-react";
import {
  composerKanbanCardChipState,
  kanbanCardSkipAtom,
  kanbanCardSkipKey,
} from "@t3tools/client-runtime/state/kanbanCardSkip";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadMessages } from "../../state/entities";
import { useThreadKanbanCard } from "../../state/kanban";

/**
 * The linked card rides on the next message until one holds it. Removing the chip sends that
 * message without it, and the card stays linked; "Add back" undoes the removal.
 */
export function ThreadComposerKanbanCardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}) {
  return props.threadRef === null ? null : (
    <CardChip environmentId={props.environmentId} threadRef={props.threadRef} />
  );
}

function CardChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const { threadId } = props.threadRef;
  const card = useThreadKanbanCard(props.environmentId, threadId);
  const messages = useThreadMessages(props.threadRef);
  const [skipped, setSkipped] = useAtom(
    kanbanCardSkipAtom(kanbanCardSkipKey(props.environmentId, threadId)),
  );
  const state = composerKanbanCardChipState(card?.id ?? null, messages, skipped);
  if (card === null || state === "hidden") return null;
  const label = `#${card.number} ${card.title}`;
  return (
    <View className="mx-3 mb-2 flex-row items-center gap-2 self-start">
      {state === "attached" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send without the card"
          onPress={() => setSkipped(true)}
          className="min-h-9 flex-row items-center gap-2 rounded-full bg-secondary px-3 active:opacity-70"
        >
          <SymbolView name="square.grid.2x2" size={14} tintColorClassName="accent-icon-muted" />
          <Text
            textRole="footnote"
            numberOfLines={1}
            className="shrink font-t3-medium text-foreground"
          >
            {label}
          </Text>
          <SymbolView name="xmark" size={12} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send ${label} with this message`}
          onPress={() => setSkipped(false)}
          className="min-h-9 flex-row items-center gap-2 rounded-full px-3 active:opacity-70"
        >
          <Text textRole="footnote" numberOfLines={1} className="shrink text-foreground-muted">
            {label} left out · Add back
          </Text>
        </Pressable>
      )}
    </View>
  );
}
