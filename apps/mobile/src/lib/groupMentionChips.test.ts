import { describe, expect, it } from "vite-plus/test";

import {
  composerGroupMentions,
  groupMentionLinkChip,
  isGroupMentionSource,
} from "./groupMentionChips";

const mentions = composerGroupMentions(
  [
    {
      id: "a1",
      handle: "Ada",
      name: "Ada Lovelace",
      avatar: { kind: "robot", hue: 210, variant: 0 },
    },
  ] as never,
  [{ name: "Billing API" }],
);

describe("group mention chips", () => {
  it("colours a member with its face's hue and names the group's projects by slug", () => {
    expect(mentions.members[0]).toEqual({ handle: "ada", name: "Ada Lovelace", accent: "#2e73b8" });
    expect(mentions.members.at(-1)).toMatchObject({ handle: "everyone", name: "Everyone" });
    expect(mentions.projects).toEqual([{ slug: "billing-api", name: "Billing API" }]);
  });

  it("draws a message's member and project links with name, face and folder", () => {
    expect(groupMentionLinkChip("t3-mention:mention/ada", mentions)).toEqual({
      label: "Ada Lovelace",
      icon: { kind: "chip", name: "bot" },
      accent: "#2e73b8",
    });
    expect(groupMentionLinkChip("t3-mention:project/billing-api", mentions)).toMatchObject({
      label: "Billing API",
      icon: { kind: "chip", name: "folder" },
    });
    expect(groupMentionLinkChip("t3-mention:mention", mentions)).toBeNull();
    expect(groupMentionLinkChip("https://ada", mentions)).toBeNull();
  });

  it("knows a pressed editor chip is a member or project", () => {
    expect(isGroupMentionSource("@Ada", mentions)).toBe(true);
    expect(isGroupMentionSource("#billing-api", mentions)).toBe(true);
    expect(isGroupMentionSource("@src/app.ts", mentions)).toBe(false);
    expect(isGroupMentionSource("@ada", undefined)).toBe(false);
  });
});
