import { describe, expect, it } from "vite-plus/test";

import { accentWash, moodTextClass, presenceBadgeLabel } from "./assistantPresenceLabels";

describe("assistant presence presentation", () => {
  it("builds hex washes", () => {
    expect(accentWash("#8b5cf6", 0.12)).toBe("#8b5cf61f");
    expect(accentWash("#8b5cf6", 0.02)).toBe("#8b5cf605");
  });

  it("names access and that it asks first only when each applies", () => {
    expect(presenceBadgeLabel(null, false)).toBe("assistant");
    expect(presenceBadgeLabel("Edits", false)).toBe("assistant · Edits");
    expect(presenceBadgeLabel("Edits", true)).toBe("assistant · Edits · asks first");
    expect(presenceBadgeLabel("Edits", false, "Tech Lead")).toBe("Tech Lead · Edits");
    expect(presenceBadgeLabel(null, false, "")).toBe("assistant");
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
