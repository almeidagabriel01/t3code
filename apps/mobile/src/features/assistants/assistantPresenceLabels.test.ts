import { describe, expect, it } from "vite-plus/test";

import {
  accentWash,
  moodTextClass,
  presenceBadgeLabel,
  presenceMessageCount,
  presenceStatusLabel,
  splitPresenceStack,
} from "./assistantPresenceLabels";

describe("assistant presence presentation", () => {
  it.each([
    [0, 0, 0],
    [3, 3, 0],
    [5, 3, 2],
  ])("stack of %i shows %i and hides %i", (total, shown, hidden) => {
    const result = splitPresenceStack(Array.from({ length: total }, (_, index) => index));
    expect(result.shown).toHaveLength(shown);
    expect(result.hidden).toBe(hidden);
  });

  it("builds hex washes, labels status and counts", () => {
    expect(accentWash("#8b5cf6", 0.12)).toBe("#8b5cf61f");
    expect(accentWash("#8b5cf6", 0.02)).toBe("#8b5cf605");
    expect(presenceStatusLabel(true)).toBe("Working");
    expect(presenceStatusLabel(false)).toBe("Idle");
    expect(presenceMessageCount({ count: 1 })).toBe("1 message here");
    expect(presenceMessageCount({ count: 2 })).toBe("2 messages here");
  });

  it("names access and that it asks first only when each applies", () => {
    expect(presenceBadgeLabel(null, false)).toBe("assistant");
    expect(presenceBadgeLabel("Edits", false)).toBe("assistant · Edits");
    expect(presenceBadgeLabel("Edits", true)).toBe("assistant · Edits · asks first");
  });
});

describe("moodTextClass", () => {
  it.each([
    ["working", false, "text-adaptive-sky-600-400"],
    ["needs", false, "text-warning-foreground"],
    ["failed", true, "text-danger-foreground"],
    ["idle", false, "text-foreground-tertiary"],
    ["idle", true, "text-drawer-foreground-muted"],
  ] as const)("%s (sidebar %s)", (mood, sidebar, expected) => {
    expect(moodTextClass(mood, sidebar)).toBe(expected);
  });
});
