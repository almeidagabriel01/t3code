import { expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { createHeavyQueueEnvironmentAtoms } from "./heavyQueue.ts";

it("builds a guarded command for every queue control, including the on/off switch", () => {
  const atoms = createHeavyQueueEnvironmentAtoms(Atom.runtime(Layer.empty) as never);
  expect(Object.keys(atoms).sort()).toEqual([
    "cancel",
    "commands",
    "move",
    "promote",
    "setClaudeHook",
    "setDeviceIdleMinutes",
    "setEnabled",
    "setMaxRunning",
    "setPaused",
    "setPriority",
    "setRule",
    "startNow",
    "state",
    "stopCommand",
  ]);
  expect(atoms.setEnabled.permissionAtom("hub" as never)).toBeDefined();
});
