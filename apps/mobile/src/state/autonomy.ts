import { useAtomValue } from "@effect/atom-react";
import { watchReply, type WatchReply } from "@t3tools/client-runtime/autonomy";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  type AutonomySettings,
  type AutonomyWatch,
  type AutonomyWatchUpsertInput,
  type EnvironmentId,
} from "@t3tools/contracts";

import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { useAssistantsEnvironmentIds } from "./assistants";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const NO_SETTINGS = serverEnvironment.settingsValueAtom("" as EnvironmentId);

/** The server's autonomy settings, and the write that replaces the whole object. */
export function useAutonomySettings(environmentId: EnvironmentId | null) {
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS : serverEnvironment.settingsValueAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "autonomy settings update",
    reportFailure: true,
  });
  return {
    autonomy: settings?.autonomy ?? DEFAULT_AUTONOMY_SETTINGS,
    write: (next: AutonomySettings) =>
      environmentId === null
        ? undefined
        : update({ environmentId, input: { patch: { autonomy: next } } }),
  };
}

/** Flips the pause switch from the settings as they are now, so a held-over closure cannot undo another edit. */
export function toggleAutonomyPause(environmentId: EnvironmentId) {
  const autonomy =
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))?.autonomy ??
    DEFAULT_AUTONOMY_SETTINGS;
  return runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    { environmentId, input: { patch: { autonomy: { ...autonomy, enabled: !autonomy.enabled } } } },
    { label: "autonomy pause", reportFailure: true, reportDefect: true },
  );
}

/** The pause switch of the first environment that runs assistants; null when none does. */
export function useAutonomyPause() {
  const environmentId = useAssistantsEnvironmentIds()[0] ?? null;
  const { autonomy } = useAutonomySettings(environmentId);
  const enabled = autonomy.enabled;
  return useMemo(
    () =>
      environmentId === null
        ? null
        : { enabled, toggle: () => void toggleAutonomyPause(environmentId) },
    [environmentId, enabled],
  );
}

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
  const settle = (result: Parameters<typeof watchReply>[0]): WatchReply => {
    const reply = watchReply(result);
    if (reply.ok) refresh();
    return reply;
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
