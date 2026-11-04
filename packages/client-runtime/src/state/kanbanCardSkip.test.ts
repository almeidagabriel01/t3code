import { describe, expect, it } from "vitest";

import {
  composerKanbanCardChipState,
  consumeKanbanCardSkip,
  kanbanCardSkipKey,
} from "./kanbanCardSkip.ts";

const delivered = [{ context: { records: [{ kind: "kanban-card", cardId: "card-1" }] } }];

describe("kanban card skip", () => {
  it.each([
    ["no card", null, [], false, "hidden"],
    ["history not loaded", "card-1", null, false, "hidden"],
    ["already delivered", "card-1", delivered, false, "hidden"],
    ["another card delivered", "card-2", delivered, false, "attached"],
    ["fresh link", "card-1", [], false, "attached"],
    ["removed by the user", "card-1", [], true, "skipped"],
  ] as const)("chip state: %s", (_name, cardId, messages, skipped, expected) => {
    expect(composerKanbanCardChipState(cardId, messages, skipped)).toBe(expected);
  });

  it("a send consumes the flag", () => {
    expect(consumeKanbanCardSkip(true)).toEqual({ attach: false, skipped: false });
    expect(consumeKanbanCardSkip(false)).toEqual({ attach: true, skipped: false });
  });

  it("keys by environment and thread", () => {
    expect(kanbanCardSkipKey("e", "t")).toBe("e\nt");
  });
});
