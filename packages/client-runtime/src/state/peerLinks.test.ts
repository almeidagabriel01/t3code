import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { peerLinkHealth, peerLinkStatusText } from "./peerLinks.ts";

const day = 24 * 60 * 60 * 1000;
const link = (
  overrides: Partial<Pick<PeerLinkSummary, "status" | "lastError">> & { readonly days: number },
): PeerLinkSummary => ({
  environmentId: EnvironmentId.make("environment-box"),
  label: "Box",
  urls: ["https://box.example"],
  access: "auto",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(overrides.days * day),
  lastReachedAt: null,
  lastError: overrides.lastError ?? null,
  status: overrides.status ?? "reachable",
});

describe("peerLinkStatusText", () => {
  it.each([
    [{ days: 20 }, "Reachable"],
    [{ days: 7 }, "Expires in 7 days unless it renews."],
    [
      { days: 1, status: "unreachable" },
      "Not answering right now. Expires in 1 day unless it renews.",
    ],
    [{ days: 20, status: "unreachable" }, "Not answering right now."],
    [
      { days: 3, lastError: "Box runs a version that cannot renew links." },
      "Box runs a version that cannot renew links. Expires in 3 days unless it renews.",
    ],
    [{ days: 0 }, "Expired. Link it again with a new pairing code."],
    [{ days: 20, status: "expired" }, "Expired. Link it again with a new pairing code."],
  ] as const)("%j reads %j", (input, expected) => {
    expect(peerLinkStatusText(peerLinkHealth(link(input), DateTime.makeUnsafe(0)))).toBe(expected);
  });
});
