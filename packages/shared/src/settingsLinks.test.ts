import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { formatSettingsLink, hostedSettingsLink, parseSettingsLinkHref } from "./settingsLinks.ts";

const env = EnvironmentId.make("env-1");

describe("settings links", () => {
  it.each([
    { page: "integrations", entry: "linear" },
    { page: "assistants", entry: undefined },
    { page: "memory", entry: "a (b) c.d #e/f&g=h ü" },
  ])("round-trips $page with entry $entry", ({ page, entry }) => {
    const href = formatSettingsLink({ environmentId: env, page, entry });
    expect(href).not.toMatch(/[()\s]/);
    expect(parseSettingsLinkHref(href)).toEqual({ environmentId: env, page, entry: entry ?? null });
  });

  it("writes the entry as a fragment", () => {
    expect(formatSettingsLink({ environmentId: env, page: "integrations", entry: "linear" })).toBe(
      "t3-settings://v1/env-1/integrations#linear",
    );
  });

  it.each([
    [
      "unknown page",
      "t3-settings://v1/env-1/not-a-page",
      { environmentId: env, page: "not-a-page", entry: null },
    ],
    [
      "unusable page",
      "t3-settings://v1/env-1/Bad%20Page#x",
      { environmentId: env, page: null, entry: "x" },
    ],
    [
      "missing env id",
      "t3-settings://v1//integrations#linear",
      { environmentId: null, page: "integrations", entry: "linear" },
    ],
    [
      "no env segment",
      "t3-settings://v1/integrations",
      { environmentId: null, page: "integrations", entry: null },
    ],
    [
      "bad escape in entry",
      "t3-settings://v1/env-1/integrations#%E0%A4%A",
      { environmentId: env, page: "integrations", entry: null },
    ],
    ["empty path", "t3-settings://v1/", { environmentId: null, page: null, entry: null }],
  ])("parses a link with %s tolerantly", (_, href, expected) => {
    expect(parseSettingsLinkHref(href)).toEqual(expected);
  });

  it.each([
    "",
    "garbage",
    "https://example.com/settings",
    "t3-settings://v2/env-1/integrations",
    "t3-thread://v1/x",
  ])("is not a settings link: %s", (href) => {
    expect(parseSettingsLinkHref(href)).toBeNull();
  });

  it("builds the hosted address", () => {
    expect(hostedSettingsLink({ environmentId: env, page: "integrations", entry: "slack" })).toBe(
      "https://app.t3.codes/settings/integrations?machine=env-1&entry=slack",
    );
    expect(hostedSettingsLink({ environmentId: env, page: "memory" }, "https://x.test")).toBe(
      "https://x.test/settings/memory?machine=env-1",
    );
  });
});
