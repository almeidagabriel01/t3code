import type { DesktopOpenAtLoginState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OPEN_AT_LOGIN_FAILED, openAtLoginRowView } from "./OpenAtLoginSettingsRow.logic";

const MAC_OFF = "Turned off in System Settings → Login Items. Turn T3 Code on there to finish.";
const WINDOWS_OFF = "Turned off in Task Manager → Startup apps.";

describe("openAtLoginRowView", () => {
  // setting × system status (null = unpackaged) × platform → switch, notice, System Settings button.
  it.each<
    [
      boolean,
      DesktopOpenAtLoginState["status"],
      "darwin" | "win32",
      boolean,
      string | null,
      boolean,
    ]
  >([
    [true, "enabled", "darwin", true, null, false],
    [true, "requires-approval", "darwin", true, MAC_OFF, true],
    [true, "not-registered", "darwin", false, OPEN_AT_LOGIN_FAILED, false],
    [false, "not-registered", "darwin", false, null, false],
    [false, "enabled", "darwin", false, null, false],
    [true, null, "darwin", true, null, false],
    [false, null, "darwin", false, null, false],
    [true, "enabled", "win32", true, null, false],
    [true, "requires-approval", "win32", true, WINDOWS_OFF, false],
    [true, "not-registered", "win32", false, OPEN_AT_LOGIN_FAILED, false],
    [false, "not-registered", "win32", false, null, false],
  ])("setting %s, status %s on %s", (enabled, status, platform, checked, notice, canOpen) => {
    const view = openAtLoginRowView({ enabled, status, platform });
    expect(view.checked).toBe(checked);
    expect(view.notice).toBe(notice);
    expect(view.canOpenSystemSettings).toBe(canOpen);
    expect(view.description).toContain(platform === "darwin" ? "this Mac" : "this computer");
  });
});
