import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AutonomyWatch, AutonomyWatchUpsertInput, EnvironmentId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export type WatchReply = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Every watch on the environment; filter by assistant where it is shown. */
export function useAutonomyWatches(environmentId: EnvironmentId) {
  return useEnvironmentQuery(serverEnvironment.autonomyWatches({ environmentId, input: {} }));
}

/** Each change settles into a reply so the form can show the server's refusal where it happened. */
export function useAutonomyWatchActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(serverEnvironment.upsertAutonomyWatch.permissionAtom(environmentId));
  const { refresh } = useAutonomyWatches(environmentId);
  const upsert = useAtomCommand(serverEnvironment.upsertAutonomyWatch, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.setAutonomyWatchEnabled, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteAutonomyWatch, { reportFailure: false });
  const settle = (
    result:
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> },
  ): WatchReply => {
    if (result._tag === "Success") {
      refresh();
      return { ok: true };
    }
    const error = squashAtomCommandFailure(result);
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The request failed. Try again.",
    };
  };
  return {
    canAct,
    save: async (input: AutonomyWatchUpsertInput) => settle(await upsert({ environmentId, input })),
    setEnabled: async (id: AutonomyWatch["id"], enabled: boolean) =>
      settle(await setEnabled({ environmentId, input: { id, enabled } })),
    remove: async (id: AutonomyWatch["id"]) =>
      settle(await remove({ environmentId, input: { id } })),
  };
}
