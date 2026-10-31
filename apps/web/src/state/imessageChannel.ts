import { useAtomValue } from "@effect/atom-react";
import {
  applyImessageStatusEvent,
  createImessageChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/imessageChannel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ImessageChannelConfigureInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const imessageEnvironment = createImessageChannelEnvironmentAtoms(connectionAtomRuntime);

const imessageEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.imessageChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-imessage-environment-ids"));

/** Connected environments whose server can talk to iMessage (Mac servers). */
export function useImessageEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(imessageEnvironmentIdsAtom);
}

/** Stored settings with the live status laid over them. */
export function useImessageSettings(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(imessageEnvironment.settings({ environmentId, input: {} }));
  const event = Option.getOrNull(
    AsyncResult.value(useAtomValue(imessageEnvironment.status({ environmentId, input: null }))),
  );
  return {
    settings: query.data && event ? applyImessageStatusEvent(query.data, event) : query.data,
    error: query.error,
    refresh: query.refresh,
  };
}

/** Whether the server can read the Messages database; `refresh` is the "Check again" button. */
export function useImessageAccess(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(imessageEnvironment.access({ environmentId, input: {} }));
  return { access: query.data?.access ?? null, error: query.error, refresh: query.refresh };
}

export type ImessageReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Each change settles into a reply, so the form can show the server's refusal where it happened. */
export function useImessageActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(imessageEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(imessageEnvironment.configure, { reportFailure: false });
  return {
    canAct,
    configure: async (input: ImessageChannelConfigureInput): Promise<ImessageReply> => {
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
