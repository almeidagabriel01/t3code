import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GuestRedeemRequest, oldestPendingGuestMessageAt } from "./guestShare.ts";

const isRedeem = Schema.is(GuestRedeemRequest);

describe("GuestRedeemRequest", () => {
  it("accepts a one-line name and rejects names that break the attribution line", () => {
    expect(isRedeem({ credential: "invite", name: "Maya Chen" })).toBe(true);
    for (const name of [
      "Maya\nowner",
      "Maya owner",
      "Maya owner",
      "Maya\u0007",
      "Theo\u202E (owner)",
      "Theo\u2066x",
    ]) {
      expect(isRedeem({ credential: "invite", name })).toBe(false);
    }
  });
});

describe("oldestPendingGuestMessageAt", () => {
  const message = (id: string, status: "pending" | "sent" | "dismissed", submittedAt: string) =>
    ({ id, text: id, status, submittedAt }) as never;
  const share = (...messages: never[]) =>
    ({
      id: "share",
      host: "env.t3.test",
      createdAt: "2026-03-09T09:00:00.000Z",
      expiresAt: "2026-03-10T09:00:00.000Z",
      guestName: "Sam",
      messages,
    }) as never;

  it.each([
    { name: "no share", share: null, expected: null },
    {
      name: "nothing pending",
      share: share(message("a", "sent", "2026-03-09T10:00:00.000Z")),
      expected: null,
    },
    {
      name: "the oldest pending wins, in any order",
      share: share(
        message("b", "pending", "2026-03-09T10:05:00.000Z"),
        message("a", "pending", "2026-03-09T10:01:00.000Z"),
      ),
      expected: "2026-03-09T10:01:00.000Z",
    },
    {
      name: "a resolved message no longer counts",
      share: share(
        message("a", "dismissed", "2026-03-09T10:01:00.000Z"),
        message("b", "pending", "2026-03-09T10:05:00.000Z"),
      ),
      expected: "2026-03-09T10:05:00.000Z",
    },
  ])("$name", ({ share, expected }) => {
    expect(oldestPendingGuestMessageAt(share)).toBe(expected);
  });
});
