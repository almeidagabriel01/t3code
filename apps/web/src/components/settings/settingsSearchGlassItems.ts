import type { SettingsSearchItem } from "./settingsSearch";
import { GENERAL_SETTINGS_COPY } from "./settingsSearchGeneralItems";

export const GLASS_SETTINGS_SEARCH_ITEMS = [
  {
    id: "appearance-style",
    title: "Style",
    description: "Choose the look of panels, menus, and dialogs.",
    to: "/settings/appearance",
    searchTerms: ["liquid glass transparent translucent wallpaper preset frosted"],
  },
  {
    id: "appearance-background",
    title: "Background",
    to: "/settings/appearance",
    searchTerms: ["wallpaper backdrop image custom liquid glass"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    description: "Higher values make menus, dialogs, and the composer more solid.",
    to: "/settings/appearance",
    searchTerms: [
      "transparent transparency solid menus dialogs composer",
      GENERAL_SETTINGS_COPY.glassOpacityLiquid,
    ],
  },
  {
    id: "desktop-system-material",
    title: "System glass",
    description: GENERAL_SETTINGS_COPY.systemMaterialAtRest,
    to: "/settings/appearance",
    searchTerms: [
      "native transparency mica windows liquid glass macos accessibility",
      GENERAL_SETTINGS_COPY.systemMaterialPreset,
    ],
    desktopOnly: true,
    requiresDesktopWindowMaterial: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
