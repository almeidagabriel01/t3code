import { useAtomValue } from "@effect/atom-react";
import {
  applyImessageStatusEvent,
  createImessageChannelEnvironmentAtoms,
} from "@t3tools/client-runtime/state/imessageChannel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ImessageChannelSettingsError,
  type EnvironmentId,
  type ImessageChannelConfigureInput,
  type ImessageChannelSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

const isImessageSettingsError = Schema.is(ImessageChannelSettingsError);

const imessageEnvironment = createImessageChannelEnvironmentAtoms(connectionAtomRuntime);

export const imessageEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.imessageChannel === true)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-imessage-environment-ids"));

/** Environments whose server runs on a Mac and can talk over iMessage. */
export function useImessageEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(imessageEnvironmentIdsAtom);
}

export type ImessageReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Settings with the live status laid over them, the Mac's access state, and the change that edits them. */
export function useImessageChannel(environmentId: EnvironmentId) {
  const settingsQuery = useEnvironmentQuery(
    imessageEnvironment.settings({ environmentId, input: {} }),
  );
  const accessQuery = useEnvironmentQuery(imessageEnvironment.access({ environmentId, input: {} }));
  const statusResult = useAtomValue(imessageEnvironment.status({ environmentId, input: null }));
  // A change answers with the new settings; showing them avoids waiting on a refetch.
  const [saved, setSaved] = useState<ImessageChannelSettings | null>(null);
  const stored = saved ?? settingsQuery.data;
  const event = AsyncResult.getOrElse(statusResult, () => null);
  const settings = stored && event ? applyImessageStatusEvent(stored, event) : stored;
  const canConfigure = useAtomValue(imessageEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(imessageEnvironment.configure, { reportFailure: false });
  return {
    settings,
    loadError: settingsQuery.error,
    access: accessQuery.data?.access ?? null,
    ownHandles: accessQuery.data?.ownHandles ?? [],
    checkAccess: accessQuery.refresh,
    canConfigure,
    configure: async (input: ImessageChannelConfigureInput): Promise<ImessageReply> => {
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
      const detail = isImessageSettingsError(failure) ? failure.detail : undefined;
      return { ok: false, message: detail ? `${detail}: ${base}` : base };
    },
  };
}
