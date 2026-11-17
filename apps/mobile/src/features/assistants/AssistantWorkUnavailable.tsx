import { environmentReachable, environmentReconnected } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { EnvironmentQueryView } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";

/** Whether the environment answers now; each reconnect refreshes the queries not yet settled on success. */
export function useRefreshOnReconnect(
  environmentId: EnvironmentId,
  queries: ReadonlyArray<Pick<EnvironmentQueryView<unknown>, "successResult" | "refresh">>,
): boolean | null {
  const reachable = environmentReachable(
    useEnvironmentPresentation(environmentId).presentation?.connection,
  );
  const previous = useRef(reachable);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the connection lives outside React; a reconnect retries what failed or hung while it was down
  useEffect(() => {
    const was = previous.current;
    previous.current = reachable;
    if (!environmentReconnected(was, reachable)) return;
    for (const query of queries) if (query.successResult === null) query.refresh();
  }, [reachable, queries]);
  return reachable;
}

/** A Work section its environment did not answer for; `onRetry` asks again by hand. */
export function AssistantWorkUnavailable(props: {
  readonly what: string;
  readonly onRetry?: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3 px-2">
      <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
        {`The environment didn't respond, so ${props.what} could not load.`}
      </Text>
      {props.onRetry ? (
        <Button label="Try again" tone="text" size="compact" onPress={props.onRetry} />
      ) : null}
    </View>
  );
}
