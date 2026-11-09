import type { DesktopTrayMenu, DesktopTrayThread } from "@t3tools/contracts";
import type * as Electron from "electron";

export const SECTION_ROWS = 8;
const TITLE_CODE_POINTS = 40;

export interface TrayMenuActions {
  readonly openApp: () => void;
  readonly newThread: () => void;
  readonly openThread: (thread: DesktopTrayThread) => void;
  readonly quit: () => void;
}

// Electron reads "&" as a mnemonic marker; "&&" draws one.
export function trayLabel(text: string, limit = TITLE_CODE_POINTS): string {
  const codePoints = Array.from(text.replace(/\s+/g, " ").trim());
  const shortened =
    codePoints.length > limit
      ? `${codePoints
          .slice(0, limit - 1)
          .join("")
          .trimEnd()}…`
      : codePoints.join("");
  return (shortened.length > 0 ? shortened : "Untitled thread").replaceAll("&", "&&");
}

function section(
  title: string,
  threads: ReadonlyArray<DesktopTrayThread>,
  nativeHeaders: boolean,
  actions: TrayMenuActions,
): Electron.MenuItemConstructorOptions[] {
  if (threads.length === 0) return [];
  return [
    nativeHeaders ? { type: "header", label: title } : { label: title, enabled: false },
    ...threads.slice(0, SECTION_ROWS).map((thread): Electron.MenuItemConstructorOptions => {
      const sublabel = [thread.project, thread.environment]
        .filter((part): part is string => part !== null && part !== "")
        .join(" · ");
      return {
        label: trayLabel(thread.title),
        // Only macOS 14.4+ draws sublabels; older versions ignore the key.
        ...(sublabel === "" ? {} : { sublabel }),
        click: () => actions.openThread(thread),
      };
    }),
    ...(threads.length > SECTION_ROWS
      ? [{ label: "Show all…", click: actions.openApp } as Electron.MenuItemConstructorOptions]
      : []),
  ];
}

export function trayMenuTemplate(input: {
  readonly menu: DesktopTrayMenu;
  readonly appName: string;
  /** macOS 14+ draws NSMenu section headers; older versions get a disabled row. */
  readonly nativeHeaders: boolean;
  readonly actions: TrayMenuActions;
}): Electron.MenuItemConstructorOptions[] {
  const { menu, appName, nativeHeaders, actions } = input;
  const sections = [
    section("Needs you", menu.attention, nativeHeaders, actions),
    section("Running", menu.running, nativeHeaders, actions),
    section("Pinned", menu.pinned, nativeHeaders, actions),
  ].filter((items) => items.length > 0);
  return [
    ...(sections.length === 0
      ? [{ label: "Nothing running", enabled: false } as Electron.MenuItemConstructorOptions]
      : sections.flatMap((items, index) => [
          ...(index === 0 ? [] : [{ type: "separator" } as Electron.MenuItemConstructorOptions]),
          ...items,
        ])),
    { type: "separator" },
    { label: "New thread", click: actions.newThread },
    { label: trayLabel(`Open ${appName}`), click: actions.openApp },
    { type: "separator" },
    { label: trayLabel(`Quit ${appName}`), click: actions.quit },
  ];
}
