import {
  type DynamicColor,
  Hct,
  MaterialDynamicColors as M,
  SchemeTonalSpot,
  argbFromHex,
  hexFromArgb,
} from "@material/material-color-utilities";
import { describe, expect, it } from "vite-plus/test";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  MOBILE_THEME_IDS,
  getThemeColorsForAppearance,
} from "@t3tools/shared/themePalettes";
import {
  readDefaultMobileThemeVariables,
  readGeneratedMobileThemeVariables,
} from "./mobileTheme.test-support";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import clerkTheme from "../../clerk-theme.json";
import type { MaterialYouPalette } from "./materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "./materialYouTheme.android";

import {
  createMobileThemeSelectionPatch,
  createMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
  getMobileThemeVariables,
  resolveMobileThemeIds,
  themeColorWithAlpha,
  themeColorToNativeColor,
} from "./mobileTheme";

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function compositeOver(overlay: string, background: string): string {
  const overlayMatch = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(overlay)!;
  const backgroundChannels = background
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16));
  const alpha = Number(overlayMatch[4]);
  const channels = [1, 2, 3].map((index) =>
    Math.round(Number(overlayMatch[index]) * alpha + backgroundChannels[index - 1]! * (1 - alpha)),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

// The default light theme's hairlines are the faintest that still read; dark needs more.
const LINE_FLOOR = { light: 1.07, dark: 1.2 } as const;

/** Lines sit on cards and on the screen: each reads on all of them, separator weakest, border strongest. */
function expectReadableLines(
  variables: Readonly<Record<string, string>>,
  appearance: "light" | "dark",
  label: string,
) {
  const screen = variables["--color-screen"]!;
  const surfaces = ["--color-grouped-card", "--color-card", "--color-screen"].map((surface) =>
    flattenThemeColor(variables[surface]!, screen),
  );
  const reading = (token: string) =>
    Math.min(
      ...surfaces.map((surface) =>
        contrastRatio(flattenThemeColor(variables[token]!, surface), surface),
      ),
    );
  const separator = reading("--color-separator");
  const subtle = reading("--color-border-subtle");
  const border = reading("--color-border");
  expect(separator, `${label}: separator reads`).toBeGreaterThanOrEqual(LINE_FLOOR[appearance]);
  expect(subtle, `${label}: border-subtle at least separator`).toBeGreaterThanOrEqual(separator);
  expect(border, `${label}: border at least border-subtle`).toBeGreaterThanOrEqual(subtle);
}

function materialYouSample(seed: string, dark: boolean): MaterialYouPalette {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), dark, 0);
  const hex = (color: DynamicColor) => hexFromArgb(color.getArgb(scheme)).toUpperCase();
  return {
    primary: hex(M.primary),
    onPrimary: hex(M.onPrimary),
    primaryContainer: hex(M.primaryContainer),
    onPrimaryContainer: hex(M.onPrimaryContainer),
    inversePrimary: hex(M.inversePrimary),
    secondaryContainer: hex(M.secondaryContainer),
    onSecondaryContainer: hex(M.onSecondaryContainer),
    tertiary: hex(M.tertiary),
    tertiaryContainer: hex(M.tertiaryContainer),
    onTertiaryContainer: hex(M.onTertiaryContainer),
    surface: hex(M.surface),
    onSurface: hex(M.onSurface),
    onSurfaceVariant: hex(M.onSurfaceVariant),
    surfaceContainer: hex(M.surfaceContainer),
    surfaceContainerHigh: hex(M.surfaceContainerHigh),
    surfaceContainerHighest: hex(M.surfaceContainerHighest),
    surfaceContainerLow: hex(M.surfaceContainerLow),
    surfaceContainerLowest: hex(M.surfaceContainerLowest),
    errorContainer: hex(M.errorContainer),
    onErrorContainer: hex(M.onErrorContainer),
    outline: hex(M.outline),
    outlineVariant: hex(M.outlineVariant),
    scrim: hex(M.scrim),
  };
}

describe("mobile themes", () => {
  it("declares every runtime theme variable in the static stylesheet", () => {
    const generatedVariables = createMobileThemeVariables(T3_CHAT_THEME.colors, "light");
    expect(Object.keys(readDefaultMobileThemeVariables("light")).sort()).toEqual(
      Object.keys(generatedVariables).sort(),
    );
    expect(Object.keys(readDefaultMobileThemeVariables("dark")).sort()).toEqual(
      Object.keys(generatedVariables).sort(),
    );
  });

  it.each(MOBILE_THEME_IDS)("uses the web color roles for %s in both appearances", (themeId) => {
    for (const appearance of ["light", "dark"] as const) {
      const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId);
      const colors = theme
        ? getThemeColorsForAppearance(theme, appearance)!
        : appearance === "dark"
          ? T3_CODE_DARK_THEME_COLORS
          : T3_CODE_LIGHT_THEME_COLORS;
      const variables =
        themeId === DEFAULT_MOBILE_THEME_ID
          ? readDefaultMobileThemeVariables(appearance)
          : getMobileThemeVariables(themeId, appearance);
      expect(variables["--color-screen"]).toBe(themeColorToNativeColor(colors.canvas));
      expect(variables["--color-thread-canvas"]).toBe(variables["--color-screen"]);
      expect(variables["--color-drawer"]).toBe(themeColorToNativeColor(colors.sidebar));
      expect(variables["--color-thread-hover"]).toBe(
        themeColorToNativeColor(colors.sidebarRowHover),
      );
      expect(variables["--color-card"]).toBe(themeColorToNativeColor(colors.surface));
      expect(variables["--color-composer-surface"]).toBe(
        themeColorWithAlpha(variables["--color-grouped-card"], appearance === "dark" ? 0.9 : 0.94),
      );
      expect(variables["--color-thread-selected"]).toBe(
        themeColorToNativeColor(colors.sidebarRowActive),
      );
      expect(variables["--color-thread-selected-foreground"]).toBe(
        themeColorToNativeColor(colors.sidebarForeground),
      );
      expect(variables["--color-primary"]).toBe(themeColorToNativeColor(colors.messageAction));
      if (themeId !== DEFAULT_MOBILE_THEME_ID) {
        expect(variables["--color-user-bubble"]).toBe(
          themeColorToNativeColor(colors.messageSurface),
        );
      }
      expect(
        contrastRatio(variables["--color-foreground"], variables["--color-screen"]),
      ).toBeGreaterThanOrEqual(4.5);
      for (const [foreground, surface] of [
        ["--color-drawer-foreground", "--color-drawer"],
        ["--color-drawer-foreground-muted", "--color-drawer"],
        ["--color-drawer-foreground", "--color-thread-hover"],
        ["--color-drawer-foreground-muted", "--color-thread-hover"],
        ["--color-thread-selected-foreground-muted", "--color-thread-selected"],
        ["--color-primary-foreground", "--color-primary"],
        ["--color-primary-text", "--color-screen"],
        ["--color-primary-text", "--color-card"],
        ["--color-primary-text", "--color-card-alt"],
        ["--color-primary-text", "--color-sheet-solid"],
        ["--color-foreground", "--color-sheet-solid"],
        ["--color-foreground-muted", "--color-sheet-solid"],
        ["--color-primary-text", "--color-grouped-card"],
        ["--color-foreground", "--color-grouped-card"],
        ["--color-foreground-muted", "--color-grouped-card"],
        ["--color-placeholder", "--color-grouped-card"],
        ["--color-secondary-foreground", "--color-secondary"],
        ["--color-user-bubble-foreground", "--color-user-bubble"],
        ["--color-warning-foreground", "--color-warning"],
        ["--color-danger-foreground", "--color-danger"],
        ["--color-md-body", "--color-screen"],
        ["--color-md-strong", "--color-screen"],
        ["--color-md-link", "--color-screen"],
        ["--color-md-code-text", "--color-md-code-bg"],
      ] as const) {
        expect(
          contrastRatio(variables[foreground], variables[surface]),
          `${appearance}: ${foreground} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(
          variables["--color-thread-selected-foreground"],
          variables["--color-thread-selected"],
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MOBILE_THEME_IDS)("keeps %s sidebar text readable on Android", (themeId) => {
    for (const appearance of ["light", "dark"] as const) {
      const variables = getMobileThemeRuntimeVariables(themeId, appearance, "android");
      for (const foreground of [
        "--color-drawer-foreground",
        "--color-drawer-foreground-muted",
      ] as const) {
        expect(
          contrastRatio(variables[foreground], variables["--color-drawer"]),
          `${appearance}: ${foreground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(MOBILE_THEME_IDS)("separates %s filled groups from their sheets", (themeId) => {
    for (const appearance of ["light", "dark"] as const) {
      const generated = readGeneratedMobileThemeVariables(
        themeId === DEFAULT_MOBILE_THEME_ID ? appearance : `${themeId}-${appearance}`,
      );
      expect(generated).toEqual(getMobileThemeVariables(themeId, appearance));
      for (const platform of ["ios", "android"]) {
        const variables = getMobileThemeRuntimeVariables(themeId, appearance, platform);
        const sheet = variables["--color-sheet-solid"];
        const group = variables["--color-grouped-card"];
        expect(
          contrastRatio(group, sheet),
          `${platform} ${appearance}: grouped surface on sheet`,
        ).toBeGreaterThanOrEqual(1.025);
        expectReadableLines(variables, appearance, `${platform} ${appearance}`);
        for (const role of [
          "--color-foreground",
          "--color-foreground-secondary",
          "--color-foreground-muted",
          "--color-placeholder",
          "--color-primary-text",
        ] as const) {
          expect(
            contrastRatio(variables[role], group),
            `${platform} ${appearance}: ${role} on grouped surface`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        if (platform === "android") {
          const header = flattenThemeColor(variables["--color-header"], sheet);
          for (const role of ["--color-header-foreground", "--color-foreground-muted"] as const) {
            expect(
              contrastRatio(variables[role], header),
              `${appearance}: ${role} on Android header`,
            ).toBeGreaterThanOrEqual(4.5);
          }
          if (appearance === "dark") {
            for (const surface of [variables["--color-screen"], header]) {
              expect(
                contrastRatio(group, surface),
                `dark grouped surface on Android ${surface}`,
              ).toBeGreaterThanOrEqual(1.2);
            }
          }
        }
        const selected = variables["--color-thread-selected"];
        expect(
          contrastRatio(selected, flattenThemeColor(variables["--color-drawer"], sheet)),
          `${platform} ${appearance}: selected row on drawer`,
        ).toBeGreaterThanOrEqual(1.2);
        for (const role of [
          "--color-thread-selected-foreground",
          "--color-thread-selected-foreground-muted",
        ] as const) {
          expect(
            contrastRatio(variables[role], selected),
            `${platform} ${appearance}: ${role} on selected row`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrastRatio(variables["--color-foreground-muted"], variables["--color-secondary"]),
          `${platform} ${appearance}: muted label on secondary surface`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("migrates one theme choice to both appearances and preserves independent choices", () => {
    expect(resolveMobileThemeIds({ themeId: "grove" })).toEqual({
      light: "grove",
      dark: "grove",
    });
    expect(
      resolveMobileThemeIds({ themeId: "grove", lightThemeId: "iris", darkThemeId: "ocean" }),
    ).toEqual({ light: "iris", dark: "ocean" });
    expect(resolveMobileThemeIds({ themeId: "grove", lightThemeId: "missing" })).toEqual({
      light: DEFAULT_MOBILE_THEME_ID,
      dark: "grove",
    });
  });

  it("changes either theme without switching the active appearance", () => {
    const themeIds = { light: "t3-chat", dark: "grove" } as const;
    expect(createMobileThemeSelectionPatch(themeIds, "light", "dark", "ocean")).toEqual({
      lightThemeId: "t3-chat",
      darkThemeId: "ocean",
      themeId: "t3-chat",
    });
    expect(createMobileThemeSelectionPatch(themeIds, "light", "light", "iris")).toEqual({
      lightThemeId: "iris",
      darkThemeId: "grove",
      themeId: "iris",
    });
  });

  it.each(["#6750A4", "#1B6EF3", "#2E7D32", "#B3261E"])(
    "keeps Material You lines readable from a %s wallpaper",
    (seed) => {
      for (const appearance of ["light", "dark"] as const) {
        const variables = materialYouPaletteToMobileThemeVariables(
          materialYouSample(seed, appearance === "dark"),
          appearance,
          getMobileThemeRuntimeVariables(DEFAULT_MOBILE_THEME_ID, appearance, "android"),
        );
        expectReadableLines(variables, appearance, appearance);
      }
    },
  );

  it("writes the Clerk theme in the hex the Clerk native plugin requires", () => {
    for (const colors of [clerkTheme.colors, clerkTheme.darkColors]) {
      for (const [role, color] of Object.entries(colors)) {
        expect(color, role).toMatch(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/);
      }
    }
  });

  it("converts OKLCH colors to React Native sRGB ColorValues", () => {
    expect(themeColorToNativeColor("oklch(1 0 0)")).toBe("#ffffff");
    expect(themeColorToNativeColor("oklch(0 0 0)")).toBe("#000000");
    expect(themeColorToNativeColor("#123456")).toBe("#123456");
  });

  it("keeps placeholders and selected-row labels readable on their mobile surfaces", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeVariables(themeId, appearance);
        expect(
          contrastRatio(variables["--color-placeholder"], variables["--color-input"]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    for (const themeId of BUILT_IN_THEME_IDS) {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeVariables(themeId, appearance);
        expect(
          contrastRatio(
            variables["--color-user-bubble-foreground"],
            variables["--color-user-bubble"],
          ),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            variables["--color-user-bubble-skill-foreground"],
            variables["--color-user-bubble"],
          ),
        ).toBeGreaterThanOrEqual(4.5);
        expect(variables["--color-user-bubble-skill-foreground"]).not.toBe(
          variables["--color-user-bubble-foreground"],
        );
        const fenceSurface = compositeOver(
          variables["--color-md-user-fence-bg"],
          variables["--color-user-bubble"],
        );
        expect(fenceSurface).not.toBe(variables["--color-user-bubble"]);
        expect(
          contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the default user bubble readable in both appearances", () => {
    for (const appearance of ["light", "dark"] as const) {
      const variables = readDefaultMobileThemeVariables(appearance);
      const bubble = variables["--color-user-bubble"];
      expect(
        contrastRatio(variables["--color-user-bubble-foreground"], bubble),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(variables["--color-user-bubble-skill-foreground"], bubble),
      ).toBeGreaterThanOrEqual(4.5);
      expect(variables["--color-user-bubble-skill-foreground"]).not.toBe(
        variables["--color-user-bubble-foreground"],
      );
      const fenceSurface = compositeOver(variables["--color-md-user-fence-bg"], bubble);
      expect(fenceSurface).not.toBe(bubble);
      expect(
        contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
      ).toBeGreaterThanOrEqual(4.5);
      const codeSurface = compositeOver(variables["--color-md-user-code-bg"], bubble);
      expect(
        contrastRatio(variables["--color-md-user-code-text"], codeSurface),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
