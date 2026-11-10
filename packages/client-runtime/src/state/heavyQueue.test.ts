import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { createHeavyQueueEnvironmentAtoms } from "./heavyQueue.ts";

it("builds a guarded command for every queue control, including the on/off switch", () => {
  const atoms = createHeavyQueueEnvironmentAtoms(Atom.runtime(Layer.empty) as never);
  expect(Object.keys(atoms).sort()).toEqual([
    "cancel",
    "move",
    "promote",
    "setEnabled",
    "setMaxRunning",
    "setPaused",
    "setRule",
    "startNow",
    "state",
  ]);
  expect(atoms.setEnabled.permissionAtom("hub" as never)).toBeDefined();
});
