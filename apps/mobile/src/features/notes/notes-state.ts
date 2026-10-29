import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { subscribeAppActive } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import { notesEnvironment } from "../../state/notes";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentSession, sessionHasScope } from "../../state/session";
import { workspaceConnections } from "../../state/workspace";
import { deliverNoteWrite } from "./delivery";
import { canEditNoteDraft } from "./notes-model";
import { createNotesOutboxController } from "./outbox-controller";
import { notesOutboxStorage } from "./outbox-store";

export const notesOutbox = createNotesOutboxController(notesOutboxStorage);
export const notesCommandOptions = { reportFailure: false, reportDefect: false } as const;

export function useNotesOutbox() {
  return useSyncExternalStore(
    notesOutbox.subscribe,
    notesOutbox.getSnapshot,
    notesOutbox.getSnapshot,
  );
}

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .some(
      (environment) =>
        environment.environmentId === environmentId && environment.connectionState === "connected",
    );

export function useNoteDraftAccess(environmentId: EnvironmentId) {
  const permission = useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
  const environment = useAtomValue(workspaceConnections.environmentsAtom).find(
    (entry) => entry.environmentId === environmentId,
  );
  const connected = environment?.connectionState === "connected";
  return {
    canEdit: canEditNoteDraft(permission, connected, environment !== undefined),
    /** Pin, unlink and start work change the note on the server, so they need it now. */
    canAct: permission && connected,
    connected,
  };
}

const settle = async <A>(
  run: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
  fallback: string,
): Promise<A> => {
  const result = await run();
  if (AsyncResult.isSuccess(result)) return result.value;
  if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
  throw new Error(fallback);
};

export function flushNotes(environmentId: EnvironmentId) {
  const canSend = () =>
    appAtomRegistry.get(notesEnvironment.write.permissionAtom(environmentId)) &&
    isConnected(environmentId);
  return notesOutbox.flush(
    environmentId,
    (input) =>
      deliverNoteWrite(
        input,
        (write) =>
          settle(
            () =>
              runAtomCommand(
                appAtomRegistry,
                notesEnvironment.write,
                { environmentId, input: write },
                notesCommandOptions,
              ),
            "The note could not sync.",
          ),
        (path) =>
          settle(
            () =>
              runAtomCommand(
                appAtomRegistry,
                notesEnvironment.read,
                { environmentId, input: { path } },
                notesCommandOptions,
              ),
            "The current version could not be loaded.",
          ),
      ),
    canSend,
    Option.getOrNull(
      AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    )?.generation ?? 0,
  );
}

// A scalar key keeps stream-driven connection updates from triggering redundant flushes.
const syncableEnvironmentsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(workspaceConnections.environmentsAtom)
    .filter(
      (environment) =>
        environment.connectionState === "connected" &&
        configs.get(environment.environmentId)?.environment.capabilities.notes === true &&
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environment.environmentId)),
          AuthOrchestrationOperateScope,
        ),
    )
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
}).pipe(Atom.withLabel("mobile-notes-syncable-environments"));

/** Sends saved drafts whenever an environment that takes them connects or the app returns. */
export function installNotesOutboxDelivery(): () => void {
  const flushAll = () => {
    const ids = appAtomRegistry.get(syncableEnvironmentsAtom).split("\n").filter(Boolean);
    void notesOutbox
      .restore()
      .then(async () => {
        for (const id of ids) await flushNotes(id as EnvironmentId);
      })
      .catch((error: unknown) => console.warn("[notes] outbox unavailable", error));
  };
  const unsubscribe = appAtomRegistry.subscribe(syncableEnvironmentsAtom, flushAll, {
    immediate: true,
  });
  const unsubscribeAppState = subscribeAppActive(flushAll);
  return () => {
    unsubscribe();
    unsubscribeAppState();
  };
}
