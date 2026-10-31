import { useAtomValue } from "@effect/atom-react";
import {
  applySlackStatusEvent,
  createSlackChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/slackChannel";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  SlackChannelSettingsError,
  type ChannelLinkCode,
  type EnvironmentId,
  type SlackChannelConfigureInput,
  type SlackChannelSettings,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const slackEnvironment = createSlackChannelEnvironmentAtoms(connectionAtomRuntime);

const slackEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.slackChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-slack-environment-ids"));

/** Environments whose server can connect Slack. */
export function useSlackEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(slackEnvironmentIdsAtom);
}

export type SlackReply<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly message: string; readonly invalidToken: boolean };

/** Settings with the live status laid over them, and the changes that edit them. */
export function useSlackChannel(environmentId: EnvironmentId) {
  const settingsQuery = useEnvironmentQuery(
    slackEnvironment.settings({ environmentId, input: {} }),
  );
  const statusResult = useAtomValue(slackEnvironment.status({ environmentId, input: null }));
  // A change answers with the new settings; showing them avoids waiting on a refetch.
  const [saved, setSaved] = useState<SlackChannelSettings | null>(null);
  const stored = saved ?? settingsQuery.data;
  const event = AsyncResult.getOrElse(statusResult, () => null);
  const settings = stored && event ? applySlackStatusEvent(stored, event) : stored;
  const identitiesQuery = useEnvironmentQuery(
    settings
      ? slackEnvironment.identities({
          environmentId,
          input: { connectionId: settings.connectionId },
        })
      : null,
  );
  const canConfigure = useAtomValue(slackEnvironment.configure.permissionAtom(environmentId));
  const canDisconnect = useAtomValue(slackEnvironment.disconnect.permissionAtom(environmentId));
  const canLink = useAtomValue(slackEnvironment.createLinkCode.permissionAtom(environmentId));
  const canUnlink = useAtomValue(slackEnvironment.unlink.permissionAtom(environmentId));
  const configure = useAtomCommand(slackEnvironment.configure, { reportFailure: false });
  const disconnect = useAtomCommand(slackEnvironment.disconnect, { reportFailure: false });
  const createLinkCode = useAtomCommand(slackEnvironment.createLinkCode, { reportFailure: false });
  const unlink = useAtomCommand(slackEnvironment.unlink, { reportFailure: false });
  const fail = (result: Parameters<typeof squashAtomCommandFailure>[0]): SlackReply<never> => {
    const failure = squashAtomCommandFailure(result);
    return {
      ok: false,
      invalidToken:
        failure instanceof SlackChannelSettingsError && failure.reason === "invalid_token",
      message:
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message
          : "The request could not be completed.",
    };
  };
  const settle = async (
    run: Promise<AtomCommandResult<SlackChannelSettings, unknown>>,
  ): Promise<SlackReply> => {
    const result = await run;
    if (result._tag !== "Success") return fail(result);
    setSaved(result.value);
    return { ok: true, value: undefined };
  };
  return {
    settings,
    loadError: settingsQuery.error,
    identities: identitiesQuery.data ?? [],
    canConfigure,
    canDisconnect,
    canLink,
    canUnlink,
    configure: (input: SlackChannelConfigureInput) => settle(configure({ environmentId, input })),
    disconnect: () => settle(disconnect({ environmentId, input: {} })),
    createLinkCode: async (
      connectionId: SlackChannelSettings["connectionId"],
    ): Promise<SlackReply<ChannelLinkCode>> => {
      const result = await createLinkCode({ environmentId, input: { connectionId } });
      return result._tag === "Success" ? { ok: true, value: result.value } : fail(result);
    },
    unlink: async (
      connectionId: SlackChannelSettings["connectionId"],
      externalActorId: string,
    ): Promise<SlackReply> => {
      const result = await unlink({ environmentId, input: { connectionId, externalActorId } });
      if (result._tag !== "Success") return fail(result);
      identitiesQuery.refresh();
      return { ok: true, value: undefined };
    },
  };
}
