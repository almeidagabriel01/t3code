// @effect-diagnostics nodeBuiltinImport:off -- reads the test files the contract points at
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";

const acp = ["apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts"];

// Each built-in driver either runs the turn-slot contract (`startNextTurnAtTurnEnd`) from the
// test files that cover its adapters, or says why it keeps no slot. A new driver fails here
// until it picks one.
const TURN_SLOT_CONTRACT: Record<string, ReadonlyArray<string> | { readonly noSlot: string }> = {
  codex: {
    noSlot:
      "Codex keeps no turn slot: its app-server admits or refuses each turn itself, so the adapter never answers previous_turn_active.",
  },
  claudeAgent: ["apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts"],
  cursor: ["packages/provider-cursor/src/server/adapter.test.ts"],
  opencode: [
    "packages/provider-opencode/src/server/adapter.test.ts",
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
  ],
  pi: ["packages/provider-pi/src/server/adapter.test.ts"],
  muse: ["packages/provider-muse/src/server/adapter.test.ts"],
  acpRegistry: acp,
  antigravity: acp,
  fx: acp,
  grok: acp,
  kiro: acp,
};

const repoFile = (path: string) =>
  NodeFS.readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

describe("turn slot contract", () => {
  it.each(BUILT_IN_DRIVERS.map((driver) => driver.driverKind))(
    "%s runs the turn-slot contract or says why it has no slot",
    (driverKind: string) => {
      const entry = TURN_SLOT_CONTRACT[driverKind];
      expect(entry, `${driverKind} needs a TURN_SLOT_CONTRACT entry`).toBeDefined();
      if (entry === undefined || "noSlot" in entry) return;
      for (const file of entry) {
        expect(repoFile(file), `${file} must call startNextTurnAtTurnEnd`).toContain(
          "startNextTurnAtTurnEnd(",
        );
      }
    },
  );
});
