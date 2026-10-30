const QUICK_BUTTON_IDS = [
  "files",
  "diff",
  "terminal",
  "preview",
  "pull-requests",
  "pull-request",
  "notes",
  "side-chat",
  "device",
] as const;
export type QuickButtonId = (typeof QUICK_BUTTON_IDS)[number];

/** Today's buttons; mirrors the `rightPanelQuickButtons` client setting default. */
export const DEFAULT_QUICK_BUTTONS: ReadonlyArray<string> = [
  "files",
  "diff",
  "terminal",
  "preview",
  "pull-requests",
];

/** The original five stay visible but disabled when unavailable; later additions hide instead. */
const DISABLED_WHEN_UNAVAILABLE: ReadonlySet<string> = new Set(DEFAULT_QUICK_BUTTONS);

const isQuickButtonId = (id: string): id is QuickButtonId =>
  (QUICK_BUTTON_IDS as readonly string[]).includes(id);

/** Known ids in saved order, without repeats; ids from other app versions are ignored. */
export function savedQuickButtons(saved: ReadonlyArray<string>): QuickButtonId[] {
  return [...new Set(saved.filter(isQuickButtonId))];
}

/** Buttons to render: the saved ones, in order, minus those hidden while unavailable. */
export function visibleQuickButtons(
  saved: ReadonlyArray<string>,
  available: Readonly<Record<QuickButtonId, boolean>>,
): QuickButtonId[] {
  return savedQuickButtons(saved).filter(
    (id) => available[id] || DISABLED_WHEN_UNAVAILABLE.has(id),
  );
}

/** Customizer rows: shown buttons in saved order, then the rest in default order. */
export function customizerQuickButtons(saved: ReadonlyArray<string>): QuickButtonId[] {
  return [...new Set([...savedQuickButtons(saved), ...QUICK_BUTTON_IDS])];
}

export function setQuickButtonShown(
  saved: ReadonlyArray<string>,
  id: QuickButtonId,
  shown: boolean,
): string[] {
  const rest = saved.filter((entry) => entry !== id);
  return shown ? [...rest, id] : rest;
}

/** Moves a shown button one step among the shown ones; other app versions' ids stay at the end. */
export function moveQuickButton(
  saved: ReadonlyArray<string>,
  id: QuickButtonId,
  delta: -1 | 1,
): string[] {
  const known = savedQuickButtons(saved);
  const from = known.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= known.length) return [...saved];
  const next = [...known];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...saved.filter((entry) => !isQuickButtonId(entry))];
}
