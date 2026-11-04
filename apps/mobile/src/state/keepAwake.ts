import { useAtomValue } from "@effect/atom-react";
import { createKeepAwakeEnvironmentAtoms } from "@t3tools/client-runtime/state/keepAwake";
import type { EnvironmentId, KeepAwakeStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

const keepAwakeEnvironment = createKeepAwakeEnvironmentAtoms(connectionAtomRuntime);

const keepAwakeStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KeepAwakeStatus | null => {
    const capable =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities.keepAwake ===
      true;
    return capable
      ? Option.getOrNull(
          AsyncResult.value(get(keepAwakeEnvironment.status({ environmentId, input: null }))),
        )
      : null;
  }).pipe(Atom.withLabel(`mobile-keep-awake-status:${environmentId}`)),
);

/** What the host is really doing; null on an older server or before the first report. */
export function useKeepAwakeStatus(environmentId: EnvironmentId): KeepAwakeStatus | null {
  return useAtomValue(keepAwakeStatusAtom(environmentId));
}
