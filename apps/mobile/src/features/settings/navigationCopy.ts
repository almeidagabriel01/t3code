import { NAVIGATION_TAB_LABELS } from "../layout/workspace/navigation-tab-order";

/** The Navigation page's fixed text; Settings search reads these same strings. */
export const NAVIGATION_COPY = {
  intro:
    "Phones show the first four enabled sections; Android tablet rails show all enabled sections. Remaining sections appear at the top of Settings. Hidden sections appear only here. Settings always stays last. Saved on this device.",
  introUnavailable:
    "Tab customization becomes available when there are six sections, including Settings.",
  title: "Navigation tabs",
  tabOrder: "Tab order",
  hidden: "Hidden",
  inSettings: "In Settings",
} as const;

export const NAVIGATION_PAGE_LABELS: readonly string[] = [
  ...Object.values(NAVIGATION_COPY),
  ...Object.values(NAVIGATION_TAB_LABELS),
];
