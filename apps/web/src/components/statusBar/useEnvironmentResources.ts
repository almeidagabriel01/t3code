import { useAtomValue } from "@effect/atom-react";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import {
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ListeningPort,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { selectKnownTerminalSessions } from "../../state/terminalSessions";
import { terminalEnvironment } from "../../state/terminal";
import { useEnvironmentListeningPorts } from "./useListeningPorts";

export interface EnvironmentResources {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly terminals: ReadonlyArray<KnownTerminalSession>;
  readonly ports: ReadonlyArray<ListeningPort>;
}

const telemetryAtoms = environmentAtomList("status-bar-telemetry", (environmentId) =>
  serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
);
const terminalAtoms = environmentAtomList("status-bar-terminals", (environmentId) =>
  terminalEnvironment.metadata({ environmentId, input: null }),
);

const valueOrNull = <A>(result: AsyncResult.AsyncResult<A, unknown> | undefined): A | null =>
  result === undefined ? null : Option.getOrNull(AsyncResult.value(result));

/** Every connected environment, each limited to the data its session grants. */
export function useEnvironmentResources(fast: boolean): ReadonlyArray<EnvironmentResources> {
  const { environments } = useEnvironments();
  const connected = environments.filter(({ connection }) => connection.phase === "connected");
  const ids = connected.map(({ environmentId }) => environmentId);
  const terminalReaders = useEnvironmentsWithScope(connected, AuthTerminalReadScope);
  const terminalIds = ids.filter((id) => terminalReaders.has(id));
  const terminalMetadata = useAtomValue(terminalAtoms(environmentIdsKey(terminalIds)));
  const ports = useEnvironmentListeningPorts(ids, fast);

  return connected.map(({ environmentId, label }) => ({
    environmentId,
    label,
    terminals: selectKnownTerminalSessions(
      valueOrNull(terminalMetadata[terminalIds.indexOf(environmentId)]),
      environmentId,
      null,
    ),
    ports: ports.get(environmentId) ?? [],
  }));
}

/** Full telemetry streams, one per environment that grants diagnostics. Call only while they are on screen. */
export function useEnvironmentSnapshots(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ResourceTelemetrySnapshot> {
  const granted = useEnvironmentsWithScope(
    environmentIds.map((environmentId) => ({ environmentId })),
    AuthDiagnosticsReadScope,
  );
  const readable = environmentIds.filter((id) => granted.has(id));
  const results = useAtomValue(telemetryAtoms(environmentIdsKey(readable)));
  return new Map(
    readable.flatMap((environmentId, index) => {
      const snapshot = valueOrNull(results[index]);
      return snapshot === null ? [] : [[environmentId, snapshot] as const];
    }),
  );
}
