import { deriveProviderSessionRestartNotice } from "@t3tools/client-runtime/providerSessionRestart";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useAtomCommand } from "../../state/use-atom-command";

export const BLOCKED_REASON = {
  running: "Wait for the current turn to finish.",
  shared: "This session is shared by several threads and can't be restarted from one.",
} as const;

/** The provider CLI was updated on disk while this thread's session still runs the old one. */
export function ProviderSessionRestartNotice(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly running: boolean;
}) {
  const structure = useQuietThreadStructure(props.threadRef);
  const restart = useAtomCommand(threadEnvironment.stopSession);
  const canRestart = useEnvironmentScope(
    props.threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const notice =
    props.threadRef === null || structure === null
      ? null
      : deriveProviderSessionRestartNotice({
          sessions: structure.projection.providerSessions,
          providers: props.providers,
          running: props.running,
        });
  if (notice === null || props.threadRef === null) return null;
  const { environmentId, threadId } = props.threadRef;
  const blockedReason = notice.blocked === null ? null : BLOCKED_REASON[notice.blocked];
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3"
    >
      <Text className="text-sm font-t3-medium text-foreground">
        {notice.providerName} {notice.installedVersion} installed
      </Text>
      <Text className="text-xs text-foreground-muted">
        {blockedReason ?? "This thread is still on the older version. Restart it to switch."}
      </Text>
      <Button
        label="Restart session"
        tone="primary"
        disabled={blockedReason !== null || !canRestart}
        onPress={() =>
          void restart({ environmentId, input: { threadId } }).then((result) => {
            if (result._tag === "Failure") Dialog.alert("Could not restart the session");
          })
        }
      />
    </View>
  );
}
