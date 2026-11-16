import { useAtomValue } from "@effect/atom-react";
import {
  applyImessageStatusEvent,
  createImessageChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/imessageChannel";
import { applyUndeliveredResend } from "@t3tools/client-runtime/state/channelUndelivered";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
  const resent = useAtomValue(imessageEnvironment.undeliveredResend(environmentId));
  const live = query.data && event ? applyImessageStatusEvent(query.data, event) : query.data;
  return {
    settings: live && applyUndeliveredResend(live, resent, event, query.dataUpdatedAt),
    error: query.error,
    refresh: query.refresh,
  };
}

/** Whether the server can read the Messages database; `refresh` is the "Check again" button. */
export function useImessageAccess(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(imessageEnvironment.access({ environmentId, input: {} }));
  return {
    access: query.data?.access ?? null,
    ownHandles: query.data?.ownHandles ?? [],
    error: query.error,
    refresh: query.refresh,
  };
}

export type ImessageReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Each change settles into a reply, so the form can show the server's refusal where it happened. */
export function useImessageActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(imessageEnvironment.configure.permissionAtom(environmentId));
  const canResend = useAtomValue(
    imessageEnvironment.resendUndelivered.permissionAtom(environmentId),
  );
  const configure = useAtomCommand(imessageEnvironment.configure, { reportFailure: false });
  const resend = useAtomCommand(imessageEnvironment.resendUndelivered, { reportFailure: false });
  const reply = (result: AtomCommandResult<unknown, unknown>): ImessageReply => {
    if (result._tag === "Success") return { ok: true };
    const error = squashAtomCommandFailure(result);
    return {
      ok: false,
      message:
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Something went wrong. Try again.",
    };
  };
  return {
    canAct,
    canResend,
    configure: async (input: ImessageChannelConfigureInput) =>
      reply(await configure({ environmentId, input })),
    resendUndelivered: async () => reply(await resend({ environmentId, input: {} })),
  };
}
