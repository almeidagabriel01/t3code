import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { cursorTurnSlotRace } from "@t3tools/provider-cursor/server/adapter.testkit";
import { museTurnSlotRace } from "@t3tools/provider-muse/server/adapter.testkit";
import { openCodeTurnSlotRace } from "@t3tools/provider-opencode/server/adapter.testkit";
import { piTurnSlotRace } from "@t3tools/provider-pi/server/adapter.testkit";
import { turnSlotRaceDrivers } from "@t3tools/provider-testing/turnEndRace";
import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import { ACP_TEST_DRIVER, acpTurnSlotRace } from "../Adapters/AcpAdapterV2.testkit.ts";
import { claudeTurnSlotRace } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { openCode2TurnSlotRace } from "../Adapters/OpenCode2AdapterV2.testkit.ts";

interface TurnSlotRace {
  /** The driver the race's adapter reports; ACP drivers share one test adapter. */
  readonly adapterDriver: string;
  readonly race: Effect.Effect<{ readonly exit: Exit.Exit<unknown, unknown> }>;
}

const turnSlotRace = <E>(
  adapterDriver: string,
  race: Effect.Effect<{ readonly exit: Exit.Exit<unknown, unknown> }, E>,
): TurnSlotRace => ({ adapterDriver, race: Effect.orDie(race) });

const acp = [turnSlotRace(ACP_TEST_DRIVER, acpTurnSlotRace)];

// Each built-in driver runs the turn-slot race (`startNextTurnAtTurnEnd`) against each of its
// adapters, or says why it keeps no slot. A new driver fails here until it picks one.
const TURN_SLOT_CONTRACT: Record<
  string,
  ReadonlyArray<TurnSlotRace> | { readonly noSlot: string }
> = {
  codex: {
    noSlot:
      "Codex keeps no turn slot: its app-server admits or refuses each turn itself, so the adapter never answers previous_turn_active.",
  },
  claudeAgent: [turnSlotRace("claudeAgent", claudeTurnSlotRace)],
  cursor: [turnSlotRace("cursor", cursorTurnSlotRace)],
  opencode: [
    turnSlotRace("opencode", openCodeTurnSlotRace),
    turnSlotRace("opencode", openCode2TurnSlotRace),
  ],
  pi: [turnSlotRace("pi", piTurnSlotRace)],
  muse: [turnSlotRace("muse", museTurnSlotRace)],
  acpRegistry: acp,
  antigravity: acp,
  fx: acp,
  grok: acp,
  kiro: acp,
};

describe("turn slot contract", () => {
  it.effect.each(BUILT_IN_DRIVERS.map((driver) => driver.driverKind))(
    "%s runs the turn-slot race or says why it has no slot",
    (driverKind: string) =>
      Effect.gen(function* () {
        const entry = TURN_SLOT_CONTRACT[driverKind];
        assert.isDefined(entry, `${driverKind} needs a TURN_SLOT_CONTRACT entry`);
        if (entry === undefined || "noSlot" in entry) return;
        for (const { adapterDriver, race } of entry) {
          turnSlotRaceDrivers.delete(adapterDriver);
          const { exit } = yield* race;
          assert.isTrue(Exit.isSuccess(exit), `${driverKind}: the next start failed: ${exit}`);
          assert.isTrue(
            turnSlotRaceDrivers.has(adapterDriver),
            `${driverKind}'s race never started the next turn at a ${adapterDriver} turn end`,
          );
        }
      }),
  );
});
