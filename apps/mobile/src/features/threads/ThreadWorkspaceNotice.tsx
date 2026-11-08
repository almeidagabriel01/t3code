import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { describeCleanedWorkspace } from "@t3tools/client-runtime/threadWorkspace";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** Shown while a thread's managed worktree folder is gone; sending a message restores it too. */
export function ThreadWorkspaceNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  /** Changes when a turn starts or ends, the moments a restore can have happened. */
  readonly turnKey: string;
}) {
  const query = useEnvironmentQuery(
    props.worktreePath === null
      ? null
      : serverEnvironment.threadWorkspaceStatus({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        }),
  );
  const restore = useAtomCommand(serverEnvironment.restoreThreadWorkspace, {
    reportFailure: false,
  });
  const canRestore = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = query;
  const seenTurnKey = useRef(props.turnKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server restores the worktree on turn start, outside this query
  useEffect(() => {
    if (seenTurnKey.current === props.turnKey) return;
    seenTurnKey.current = props.turnKey;
    refresh();
  }, [props.turnKey, refresh]);
  if (query.data?.state !== "cleaned") return null;

  const run = async () => {
    setPending(true);
    setError(null);
    const result = await restore({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not restore the worktree.");
      return;
    }
    refresh();
  };

  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3"
    >
      <Text className="text-sm font-t3-medium text-foreground">Worktree cleaned up</Text>
      <Text className="text-xs text-foreground-muted">
        {describeCleanedWorkspace(query.data)} Sending a message restores it as well.
      </Text>
      {error !== null ? <Text className="text-xs text-danger-foreground">{error}</Text> : null}
      <Button
        label={pending ? "Restoring…" : "Restore"}
        tone="primary"
        disabled={pending || !canRestore}
        onPress={() => void run()}
      />
    </View>
  );
}
