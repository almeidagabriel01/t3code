import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ListeningPort,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { PORTS_REFRESH_MS } from "@t3tools/shared/statusBarRefresh";

import { useClientSettings } from "../../hooks/useSettings";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";

const FAST_POLL_MS = 3_000;
const NO_PORTS: ReadonlyArray<ListeningPort> = [];

const portsAtoms = environmentAtomList("status-bar-listening-ports", (environmentId) =>
  serverEnvironment.listeningPorts({ environmentId, input: {} }),
);

/**
 * Pulls every host listener from each environment that grants diagnostics. Polls slowly, and
 * quickly while `fast` (a list is on screen).
 */
export function useEnvironmentListeningPorts(
  environmentIds: ReadonlyArray<EnvironmentId>,
  fast: boolean,
): ReadonlyMap<EnvironmentId, ReadonlyArray<ListeningPort>> {
  const registry = useContext(RegistryContext);
  const granted = useEnvironmentsWithScope(
    environmentIds.map((environmentId) => ({ environmentId })),
    AuthDiagnosticsReadScope,
  );
  const readable = environmentIds.filter((environmentId) => granted.has(environmentId));
  const key = environmentIdsKey(readable);
  const results = useAtomValue(portsAtoms(key));
  const slowPollMs = PORTS_REFRESH_MS[useClientSettings((s) => s.statusBarPortsRefresh)];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-pulls an on-demand host listing
  useEffect(() => {
    if (key === "") return;
    const ids = key.split("\n") as EnvironmentId[];
    const refresh = () => {
      if (document.hidden) return;
      for (const environmentId of ids) {
        registry.refresh(serverEnvironment.listeningPorts({ environmentId, input: {} }));
      }
    };
    if (fast) refresh();
    const timer = setInterval(refresh, fast ? FAST_POLL_MS : slowPollMs);
    return () => clearInterval(timer);
  }, [key, fast, slowPollMs, registry]);

  return new Map(
    readable.map((environmentId, index) => [
      environmentId,
      Option.getOrElse(AsyncResult.value(results[index]!), () => NO_PORTS),
    ]),
  );
}

/** One environment's listeners (the primary by default), optionally narrowed to a project. */
export function useListeningPorts({
  environmentId,
  projectId,
  fast = false,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly fast?: boolean | undefined;
} = {}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const id = environmentId === undefined ? primaryEnvironmentId : environmentId;
  const byEnvironment = useEnvironmentListeningPorts(id === null ? [] : [id], fast);
  const all = (id === null ? undefined : byEnvironment.get(id)) ?? NO_PORTS;
  return {
    environmentId: id,
    canRead: id !== null && byEnvironment.has(id),
    ports: projectId === undefined ? all : all.filter((port) => port.projectId === projectId),
  };
}
