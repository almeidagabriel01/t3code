import { useAtomValue } from "@effect/atom-react";
import {
  applyTelegramStatusEvent,
  createTelegramChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/telegramChannel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  TelegramChannelSettingsError,
  type EnvironmentId,
  type TelegramChannelConfigureInput,
  type TelegramChannelSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const isTelegramSettingsError = Schema.is(TelegramChannelSettingsError);

const telegramEnvironment = createTelegramChannelEnvironmentAtoms(connectionAtomRuntime);

export const telegramEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.telegramChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-telegram-environment-ids"));

/** Environments whose server can talk over Telegram. */
export function useTelegramEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(telegramEnvironmentIdsAtom);
}

export type TelegramReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Settings with the live status laid over them, and the change that edits them. */
export function useTelegramChannel(environmentId: EnvironmentId) {
  const settingsQuery = useEnvironmentQuery(
    telegramEnvironment.settings({ environmentId, input: {} }),
  );
  const statusResult = useAtomValue(telegramEnvironment.status({ environmentId, input: null }));
  // A change answers with the new settings; showing them avoids waiting on a refetch.
  const [saved, setSaved] = useState<TelegramChannelSettings | null>(null);
  const stored = saved ?? settingsQuery.data;
  const event = AsyncResult.getOrElse(statusResult, () => null);
  const settings = stored && event ? applyTelegramStatusEvent(stored, event) : stored;
  const canConfigure = useAtomValue(telegramEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(telegramEnvironment.configure, { reportFailure: false });
  return {
    settings,
    loadError: settingsQuery.error,
    canConfigure,
    configure: async (input: TelegramChannelConfigureInput): Promise<TelegramReply> => {
      const result = await configure({ environmentId, input });
      if (result._tag === "Success") {
        setSaved(result.value);
        return { ok: true };
      }
      const failure = squashAtomCommandFailure(result);
      const base =
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : "The request could not be completed.";
      const detail = isTelegramSettingsError(failure) ? failure.detail : undefined;
      return { ok: false, message: detail ? `${detail}: ${base}` : base };
    },
  };
}
