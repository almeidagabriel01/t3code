import { createDeviceEnvironmentAtoms } from "@t3tools/client-runtime/state/device";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, usePreparedConnection } from "./session";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

/** Environments with device support on, the only ones with devices to set access for. */
const deviceEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.settings.enableDeviceSupport)
    .map(([environmentId]) => environmentId);
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  const prior = previous._tag === "Some" ? previous.value : null;
  return prior !== null && prior.length === next.length && prior.every((id, i) => id === next[i])
    ? prior
    : next;
}).pipe(Atom.withLabel("mobile-device-environment-ids"));

export function useDeviceEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(deviceEnvironmentIdsAtom);
}

// Hub tickets are single use, so each viewer resolves its own access: a new
// viewer (a reload, a device switch, a return to the screen) never reuses a
// ticket an earlier connection already spent.
const deviceHubAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((_viewer: string) =>
    connectionAtomRuntime
      .atom((get) => {
        const prepared = Option.getOrNull(
          get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
        return prepared === null
          ? Effect.never
          : resolveDeviceHubAccess({ prepared, hubBasePath: "/api/device-hub" });
      })
      .pipe(Atom.withLabel(`mobile-device-hub-access:${environmentId}`)),
  ),
);

export function useDeviceHubAccess(environmentId: EnvironmentId, hostId: string, viewer: string) {
  const prepared = usePreparedConnection(environmentId);
  const query = useEnvironmentQuery(deviceHubAccessAtom(environmentId)(viewer));
  const access =
    query.data && query.error === null && Option.isSome(prepared)
      ? { ...query.data, query: { ...query.data.query, hostId } }
      : null;
  return { access, error: query.error, refresh: query.refresh };
}
