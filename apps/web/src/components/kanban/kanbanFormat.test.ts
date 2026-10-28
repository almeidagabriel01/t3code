import { describe, expect, it } from "vite-plus/test";

import { formatDueLabel, isDueOverdue } from "./kanbanFormat";

const noon = (day: number) => new Date(2026, 9, day, 12).toISOString();
const now = new Date(2026, 9, 28, 9).getTime();

describe("due labels", () => {
  it("names the days around today", () => {
    expect(formatDueLabel(noon(28), now)).toBe("Today");
    expect(formatDueLabel(noon(29), now)).toBe("Tomorrow");
    expect(formatDueLabel(noon(27), now)).toBe("Yesterday");
  });

  it("shows the date otherwise, with the year only when it differs", () => {
    expect(formatDueLabel(noon(30), now)).not.toMatch(/2026/);
    expect(formatDueLabel(new Date(2027, 0, 5).toISOString(), now)).toMatch(/2027/);
  });

  it("is overdue only after the due day", () => {
    expect(isDueOverdue(noon(28), now)).toBe(false);
    expect(isDueOverdue(noon(27), now)).toBe(true);
  });
});
