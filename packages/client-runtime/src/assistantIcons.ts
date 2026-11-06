import type { AssistantIconId } from "@t3tools/contracts";

/** Stroke-based (1.75, round caps and joins) on a 24x24 grid, so they sit with the app's icons. */
export const ASSISTANT_ICON_VIEWBOX = 24;
export const ASSISTANT_ICON_STROKE_WIDTH = 1.75;

const head = (x: number, y: number, w: number, h: number) =>
  `M${x + 2} ${y}h${w - 4}a2 2 0 0 1 2 2v${h - 4}a2 2 0 0 1-2 2H${x + 2}a2 2 0 0 1-2-2V${y + 2}a2 2 0 0 1 2-2z`;

export interface AssistantIconDefinition {
  readonly id: AssistantIconId;
  readonly label: string;
  /** SVG path `d` strings, stroked and unfilled. */
  readonly paths: ReadonlyArray<string>;
}

export const ASSISTANT_ICONS: ReadonlyArray<AssistantIconDefinition> = [
  {
    id: "bot",
    label: "Classic bot",
    paths: [
      head(4, 8, 16, 11),
      "M9 12.5v1.5",
      "M15 12.5v1.5",
      "M12 8V5",
      "M12 3.2v.1",
      "M2 12v3",
      "M22 12v3",
    ],
  },
  {
    id: "visor",
    label: "Visor bot",
    paths: [
      "M5 13a7 7 0 0 1 14 0v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z",
      "M8 11.5h8a1.5 1.5 0 0 1 0 3H8a1.5 1.5 0 0 1 0-3z",
      "M12 6V3",
    ],
  },
  {
    id: "helper",
    label: "Round helper",
    paths: [
      "M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16z",
      "M9 12.5v.1",
      "M15 12.5v.1",
      "M9.5 16a3.5 3.5 0 0 0 5 0",
      "M12 5V2.5",
    ],
  },
  {
    id: "analyst",
    label: "Analyst",
    paths: [head(3, 6, 18, 13), "M7 15l3-3 2.5 2L17 10", "M12 6V3"],
  },
  {
    id: "builder",
    label: "Builder",
    paths: [
      head(3, 9, 18, 10),
      "M9 13v1.5",
      "M15 13v1.5",
      "M12 9V6.5",
      "M10 2v2.5a2 2 0 0 0 4 0V2",
    ],
  },
  {
    id: "guardian",
    label: "Guardian",
    paths: [
      "M12 3l7.5 2.5V11c0 4.5-3 8.2-7.5 10-4.5-1.8-7.5-5.5-7.5-10V5.5z",
      "M9.5 10.5V12",
      "M14.5 10.5V12",
      "M9.5 15.5h5",
    ],
  },
  {
    id: "scout",
    label: "Scout",
    paths: [
      head(4, 11, 16, 9),
      "M9 14.5V16",
      "M15 14.5V16",
      "M12 11V9",
      "M9.5 6.8a3.5 3.5 0 0 1 5 0",
      "M7 4.2a7 7 0 0 1 10 0",
    ],
  },
  {
    id: "scribe",
    label: "Scribe",
    paths: [
      head(4, 9, 16, 10),
      "M9 13v1.5",
      "M15 13v1.5",
      "M9 17h6",
      "M12 9V6",
      "M10.5 6L12 2l1.5 4z",
    ],
  },
  {
    id: "finance",
    label: "Finance",
    paths: [
      "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      "M14.5 9.5C14 8.5 13 8 12 8c-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5",
      "M12 6V8",
      "M12 16v2",
    ],
  },
  {
    id: "spark",
    label: "Spark",
    paths: ["M12 3l2 6.5 6.5 2.5-6.5 2.5L12 21l-2-6.5L3.5 12 10 9.5z", "M19 3v3", "M17.5 4.5h3"],
  },
];

const BY_ID = new Map<string, AssistantIconDefinition>(
  ASSISTANT_ICONS.map((icon) => [icon.id, icon]),
);

/** Null for no icon or an id this client does not know, so the avatar falls back to the initial. */
export function assistantIconFor(icon: string | null | undefined): AssistantIconDefinition | null {
  return (icon != null && BY_ID.get(icon)) || null;
}
