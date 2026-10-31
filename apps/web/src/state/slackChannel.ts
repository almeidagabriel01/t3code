import { useAtomValue } from "@effect/atom-react";
import {
  applySlackStatusEvent,
  createSlackChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/slackChannel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ChannelLinkCode,
  EnvironmentId,
  SlackChannelConfigureInput,
  SlackChannelConnectionId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const slackEnvironment = createSlackChannelEnvironmentAtoms(connectionAtomRuntime);

const slackEnvironmentIdsAtom = Atom.make((get) => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.slackChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("web-slack-environment-ids"));

/** Connected environments whose server can talk to Slack. */
export function useSlackEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(slackEnvironmentIdsAtom);
}

/** Stored settings with the live connection status laid over them. */
export function useSlackSettings(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(slackEnvironment.settings({ environmentId, input: {} }));
  const event = Option.getOrNull(
    AsyncResult.value(useAtomValue(slackEnvironment.status({ environmentId, input: null }))),
  );
  return {
    settings: query.data && event ? applySlackStatusEvent(query.data, event) : query.data,
    error: query.error,
    refresh: query.refresh,
  };
}

export function useSlackIdentities(
  environmentId: EnvironmentId,
  connectionId: SlackChannelConnectionId | null,
) {
  return useEnvironmentQuery(
    connectionId === null
      ? null
      : slackEnvironment.identities({ environmentId, input: { connectionId } }),
  );
}

export type SlackReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string };

const REASON_COPY: Record<string, string> = {
  adapter_unavailable: "Slack is not available on this server.",
  invalid_input: "These Slack settings are not valid.",
  invalid_token: "Slack rejected this token",
  persistence_failed: "Could not save the Slack settings.",
};

function failureMessage(error: unknown): string {
  const reason = (error as { readonly reason?: unknown } | null)?.reason;
  if (typeof reason === "string" && REASON_COPY[reason]) return REASON_COPY[reason];
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Something went wrong. Try again.";
}

/** Each change settles into a reply, so the form can show a refusal where it happened. */
export function useSlackActions(environmentId: EnvironmentId) {
  const canAct = useAtomValue(slackEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(slackEnvironment.configure, { reportFailure: false });
  const disconnect = useAtomCommand(slackEnvironment.disconnect, { reportFailure: false });
  const createLinkCode = useAtomCommand(slackEnvironment.createLinkCode, { reportFailure: false });
  const unlink = useAtomCommand(slackEnvironment.unlink, { reportFailure: false });
  const reply = async <A>(
    run: Promise<
      | { readonly _tag: "Success"; readonly value: A }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
    >,
  ): Promise<SlackReply<A>> => {
    const result = await run;
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, message: failureMessage(squashAtomCommandFailure(result)) };
  };
  return {
    canAct,
    configure: (input: SlackChannelConfigureInput) => reply(configure({ environmentId, input })),
    disconnect: () => reply(disconnect({ environmentId, input: {} })),
    createLinkCode: (
      connectionId: SlackChannelConnectionId,
    ): Promise<SlackReply<ChannelLinkCode>> =>
      reply(createLinkCode({ environmentId, input: { connectionId } })),
    unlink: (connectionId: SlackChannelConnectionId, externalActorId: string) =>
      reply(unlink({ environmentId, input: { connectionId, externalActorId } })),
  };
}
