import type { ToolCallVisibility } from "@t3tools/contracts/settings";

import { MOBILE_THEME_OPTIONS, type MobileThemeMode } from "../../../lib/mobileTheme";

export const APPEARANCE_MODES: ReadonlyArray<{
  readonly id: MobileThemeMode;
  readonly label: string;
}> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const TOOL_CALL_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: ToolCallVisibility;
  readonly label: string;
}> = [
  { value: "showAll", label: "Show all" },
  { value: "hideSuccessful", label: "Hide successful" },
  { value: "hideAll", label: "Hide all" },
  { value: "zen", label: "Zen" },
];

/** The Appearance sections' fixed labels; Settings search reads these same strings. */
export const APPEARANCE_COPY = {
  theme: { colorScheme: "Color scheme", themes: "Themes" },
  androidNavigation: {
    title: "Navigation",
    oneUi: {
      title: "One UI",
      description: "Floating navigation with a separate compose button.",
    },
    material: {
      title: "Material",
      description: "Standard Android navigation bar and side rail.",
    },
  },
  text: { title: "Text", textSize: "Text size", renderMath: "Render math" },
  terminal: { title: "Terminal", customFontSize: "Custom font size", fontSize: "Font size" },
  code: {
    title: "Code & Diffs",
    customFontSize: "Custom font size",
    fontSize: "Font size",
    wordBreak: "Word break",
  },
  toolCalls: {
    title: "Tool calls in chat",
    footer:
      "Hide the commands, edits, and searches agents run. Hide successful keeps failures. Zen shows only final answers. Approvals, questions, and errors always show.",
  },
} as const;

const { theme, androidNavigation, text, terminal, code, toolCalls } = APPEARANCE_COPY;

export const APPEARANCE_PAGE_LABELS: readonly string[] = [
  theme.colorScheme,
  // iOS and Android name this setting Dark Mode / Dark theme.
  "dark mode",
  "light mode",
  ...APPEARANCE_MODES.map(({ label }) => label),
  theme.themes,
  ...MOBILE_THEME_OPTIONS.map(({ label }) => label),
  androidNavigation.title,
  androidNavigation.oneUi.title,
  androidNavigation.oneUi.description,
  androidNavigation.material.title,
  androidNavigation.material.description,
  ...Object.values(text),
  ...Object.values(terminal),
  ...Object.values(code),
  toolCalls.title,
  ...TOOL_CALL_VISIBILITY_OPTIONS.map(({ label }) => label),
  toolCalls.footer,
  // Common names for the color scheme and the tool call visibility rows.
  "colors",
  "work log",
];
