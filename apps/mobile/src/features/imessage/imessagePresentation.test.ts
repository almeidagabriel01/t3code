import { describe, expect, it } from "vite-plus/test";

import {
  imessageAccessRow,
  imessageDeliveryNote,
  imessageEnableBlocker,
  imessageStatusLabel,
  parseImessageHandle,
} from "./imessagePresentation";

const settings = (over: Record<string, unknown> = {}) =>
  ({ enabled: false, allowedHandles: [], selfHandles: [], status: "disabled", ...over }) as never;

describe("iMessage presentation", () => {
  it.each([
    [{ status: "disabled" }, "Off"],
    [{ status: "running" }, "Running"],
    [{ status: "error", lastError: "full_disk_access_missing" }, "Full Disk Access"],
    [{ status: "error", lastError: "database_unavailable" }, "could not be opened"],
    [{ status: "error", lastError: "automation_denied" }, "Automation"],
    [{ status: "error", lastError: "messages_not_signed_in" }, "not signed in"],
    [{ status: "error" }, "could not start"],
  ])("labels %j", (over, text) => {
    expect(imessageStatusLabel(settings(over))).toContain(text);
  });

  it("explains a failed delivery and stays quiet otherwise", () => {
    expect(imessageDeliveryNote(settings())).toBeNull();
    const note = (code: string) =>
      imessageDeliveryNote(settings({ lastDeliveryError: { code, at: "2026-01-01" } }));
    expect(note("timeout")).toContain("too long");
    expect(note("something_else")).toContain("could not be delivered");
  });

  it.each([
    [null, "Checking…"],
    ["ok", "Granted"],
    ["full_disk_access_missing", "Not granted"],
    ["messages_not_signed_in", "Not signed in"],
    ["database_unavailable", "Unavailable"],
  ] as const)("describes access %s", (access, label) => {
    expect(imessageAccessRow(access).label).toBe(label);
  });

  it("names the Full Disk Access steps", () => {
    expect(imessageAccessRow("full_disk_access_missing").description).toContain(
      "System Settings → Privacy & Security → Full Disk Access",
    );
  });

  it("blocks enabling until access is granted and a handle exists", () => {
    expect(imessageEnableBlocker("full_disk_access_missing", settings())).toBe(
      "Grant access first.",
    );
    expect(imessageEnableBlocker(null, settings())).toBe("Grant access first.");
    expect(imessageEnableBlocker("ok", settings())).toContain("Add at least one");
    expect(imessageEnableBlocker("ok", settings({ selfHandles: ["+1555"] }))).toBeNull();
    expect(imessageEnableBlocker("ok", settings({ allowedHandles: ["a@b.c"] }))).toBeNull();
  });

  it("trims handles and rejects blanks and duplicates", () => {
    expect(parseImessageHandle("  ", [])).toHaveProperty("error");
    expect(parseImessageHandle("+55 (11) 9", [])).toEqual({ handle: "+55119" });
    expect(parseImessageHandle(" A@B.com ", ["a@b.com"])).toEqual({
      error: "That is already added.",
    });
    expect(parseImessageHandle(" +5511 ", [])).toEqual({ handle: "+5511" });
    expect(parseImessageHandle("+55 (11) 99999-8888", ["+5511999998888"])).toHaveProperty("error");
  });
});
