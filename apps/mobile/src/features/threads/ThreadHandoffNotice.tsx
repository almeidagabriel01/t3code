import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useQuietThreadShell } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** Tells a handed-off thread where its work continued. */
export function ThreadHandoffNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
}) {
  const target = useQuietThreadShell(scopeThreadRef(props.environmentId, props.targetThreadId));
  const openLinkedThread = useOpenLinkedThread();
  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="font-t3-bold text-sm text-foreground">Handed off to another agent</Text>
        {target === null ? null : (
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {target.title}
          </Text>
        )}
      </View>
      <Button
        label="Open"
        tone="secondary"
        onPress={() =>
          openLinkedThread({
            environmentId: String(props.environmentId),
            threadId: String(props.targetThreadId),
          })
        }
      />
    </View>
  );
}
