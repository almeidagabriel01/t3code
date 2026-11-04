import { useAtomValue } from "@effect/atom-react";
import {
  applyTelegramStatusEvent,
  createTelegramChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/telegramChannel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TelegramChannelConfigureInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const telegramEnvironment = createTelegramChannelEnvironmentAtoms(connectionAtomRuntime);

const telegramEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.telegramChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-telegram-environment-ids"));

/** Connected environments whose server can talk over Telegram. */
export function useTelegramEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(telegramEnvironmentIdsAtom);
}

/** Stored settings with the live status laid over them. */
export function useTelegramSettings(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(telegramEnvironment.settings({ environmentId, input: {} }));
  const event = Option.getOrNull(
    AsyncResult.value(useAtomValue(telegramEnvironment.status({ environmentId, input: null }))),
  );
  return {
    settings: query.data && event ? applyTelegramStatusEvent(query.data, event) : query.data,
    error: query.error,
    refresh: query.refresh,
  };
}

export type TelegramReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Each change settles into a reply, so the form can show the server's refusal where it happened. */
export function useTelegramActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(telegramEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(telegramEnvironment.configure, { reportFailure: false });
  return {
    canAct,
    configure: async (input: TelegramChannelConfigureInput): Promise<TelegramReply> => {
      const result = await configure({ environmentId, input });
      if (result._tag === "Success") return { ok: true };
      const error = squashAtomCommandFailure(result);
      return {
        ok: false,
        message:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Something went wrong. Try again.",
      };
    },
  };
}
