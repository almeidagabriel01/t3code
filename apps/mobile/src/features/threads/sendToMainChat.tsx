import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Appends to the parent's draft (after a blank line when it has text) and opens the parent to review. */
export function useSendToMainChat(
  environmentId: EnvironmentId,
  parentThreadId: ThreadId | null,
): ((text: string) => void) | undefined {
  const openLinkedThread = useOpenLinkedThread();
  if (parentThreadId === null) return undefined;
  return (text) => {
    const key = scopedThreadKey(scopeThreadRef(environmentId, parentThreadId));
    const current = getComposerDraftSnapshot(key).text;
    setComposerDraftText(key, current.trim().length === 0 ? text : `${current}\n\n${text}`);
    openLinkedThread({ environmentId, threadId: parentThreadId });
  };
}

export function SendToMainChatButton(props: {
  readonly iconColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Send to main chat"
      onPress={props.onPress}
      className="h-7 w-7 items-center justify-center"
      style={
        Platform.OS === "android"
          ? { width: props.buttonSize, height: props.buttonSize }
          : undefined
      }
    >
      <SymbolView
        name="arrow.turn.left.up"
        size={props.iconSize}
        tintColor={props.iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
