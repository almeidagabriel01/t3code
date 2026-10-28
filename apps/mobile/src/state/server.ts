import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { Atom } from "effect/reactivity";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
});
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const threadListEnvironmentsAtom = createThreadListEnvironmentsAtom(
  environmentServerConfigsAtom,
);

/** `environmentId:projectId` of every project opened with Open folder. */
export const folderProjectKeysAtom = Atom.make(
  (get) =>
    new Set(
      [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) =>
        Object.keys(
          get(serverEnvironment.settingsValueAtom(environmentId))?.folderProjects ?? {},
        ).map((projectId) => `${environmentId}:${projectId}`),
      ),
    ),
).pipe(Atom.withLabel("mobile-folder-project-keys"));
