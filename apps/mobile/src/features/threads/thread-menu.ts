import type { MenuAction } from "@react-native-menu/menu";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { HANDOFF_ICON, HANDOFF_LABEL } from "./thread-handoff";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { resolveThreadListV2SnoozeMenuSelection } from "./threadListV2";

type SnoozePresets = Parameters<
  typeof resolveThreadListV2SnoozeMenuSelection
>[0]["displayedPresets"];

const DELETE: MenuAction = {
  id: "delete",
  title: "Delete",
  image: "trash",
  attributes: { destructive: true },
};
const ARCHIVE: MenuAction = { id: "archive", title: "Archive", image: "archivebox" };

export function buildSnoozePresetActions(
  presets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly whenLabel: string;
  }>,
): MenuAction[] {
  return [
    ...presets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: "Custom…" },
  ];
}

/** Which of the list's menus a thread gets; the open thread uses the same rules. */
export type ThreadMenuKind = "snoozed" | "legacy" | "slim" | "snoozableCard" | "card";

export function resolveThreadMenuKind(input: {
  readonly snoozed: boolean;
  readonly settlementSupported: boolean;
  readonly settled: boolean;
  readonly snoozable: boolean;
}): ThreadMenuKind {
  if (input.snoozed) return "snoozed";
  if (!input.settlementSupported) return "legacy";
  if (input.settled) return "slim";
  return input.snoozable ? "snoozableCard" : "card";
}

export interface ThreadMenuInput {
  readonly kind: ThreadMenuKind;
  /** Platform wording; null when the thread has no branch to start from. */
  readonly newThreadOnBranchTitle: string | null;
  readonly pinned: boolean;
  readonly pinningSupported: boolean;
  /** List only: arranging threads has no meaning from inside one thread. */
  readonly reorder?: {
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
  };
  readonly autoSettle: { readonly supported: boolean; readonly enabled: boolean };
  readonly titleRegeneration: { readonly supported: boolean; readonly regenerating: boolean };
  readonly canHandoff: boolean;
  readonly turnIntoProject: { readonly archivable: boolean } | null;
  readonly snoozePresetActions: ReadonlyArray<MenuAction>;
}

export function buildThreadMenuActions(input: ThreadMenuInput): MenuAction[] {
  const arrangement: MenuAction[] = [
    ...(input.reorder
      ? [
          { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
          {
            id: "move-up",
            title: "Move up",
            image: "arrow.up",
            attributes: { disabled: !input.reorder.canMoveUp },
          },
          {
            id: "move-down",
            title: "Move down",
            image: "arrow.down",
            attributes: { disabled: !input.reorder.canMoveDown },
          },
        ]
      : []),
    ...(input.pinningSupported
      ? [
          input.pinned
            ? { id: "unpin", title: "Unpin", image: "pin.slash" }
            : { id: "pin", title: "Pin", image: "pin" },
        ]
      : []),
  ];
  const slimArrangement = arrangement.filter((a) => a.id !== "move-up" && a.id !== "move-down");
  const autoSettle: MenuAction[] = input.autoSettle.supported
    ? [
        {
          id: "auto-settle",
          title: "Auto-settle behavior",
          image: "timer",
          subactions: [
            {
              id: "auto-settle:enabled",
              title: "Enabled",
              state: input.autoSettle.enabled ? "on" : "off",
            },
            {
              id: "auto-settle:disabled",
              title: "Disabled",
              state: input.autoSettle.enabled ? "off" : "on",
            },
          ],
        },
      ]
    : [];
  const title: MenuAction[] = [
    { id: "rename", title: "Rename", image: "square.and.pencil" },
    ...buildThreadTitleRegenerationMenuItems({
      supported: input.titleRegeneration.supported,
      isRegenerating: input.titleRegeneration.regenerating,
    }),
    ...(input.canHandoff ? [{ id: "handoff", title: HANDOFF_LABEL, image: HANDOFF_ICON }] : []),
    ...(input.turnIntoProject
      ? [
          {
            id: "turn-into-project",
            title: "Turn into project",
            image: "folder.badge.plus",
            attributes: { disabled: !input.turnIntoProject.archivable },
          },
        ]
      : []),
  ];
  const head: MenuAction[] = [
    ...(input.newThreadOnBranchTitle
      ? [
          {
            id: "new-thread-on-branch",
            title: input.newThreadOnBranchTitle,
            image: "square.and.pencil",
          },
        ]
      : []),
    { id: "copy-thread", title: "Copy thread", image: "text.bubble" },
    { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
  ];
  const settle: MenuAction = { id: "settle", title: "Settle", image: "checkmark" };
  const body: MenuAction[] = (() => {
    switch (input.kind) {
      case "snoozed":
        return [
          { id: "unsnooze", title: "Wake thread", image: "clock" },
          ...title,
          ...autoSettle,
          ARCHIVE,
          DELETE,
        ];
      case "legacy":
        return [ARCHIVE, ...arrangement, ...title, DELETE];
      case "slim":
        return [
          { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" },
          ...slimArrangement,
          ...title,
          ...autoSettle,
          ARCHIVE,
          DELETE,
        ];
      case "snoozableCard":
        return [
          settle,
          {
            id: "snooze",
            title: "Snooze",
            image: "clock",
            subactions: [...input.snoozePresetActions],
          },
          ...arrangement,
          ...title,
          ...autoSettle,
          ARCHIVE,
          DELETE,
        ];
      case "card":
        return [settle, ...arrangement, ...title, ...autoSettle, ARCHIVE, DELETE];
    }
  })();
  return [...head, ...body];
}

export interface ThreadMenuHandlers {
  readonly newThreadOnBranch?: () => void;
  readonly copyThread: () => void;
  readonly copyThreadId: () => void;
  readonly settle: () => void;
  readonly unsettle: () => void;
  readonly unsnooze: () => void;
  readonly pin: () => void;
  readonly unpin: () => void;
  readonly setAutoSettle: (enabled: boolean) => void;
  readonly arrange?: () => void;
  readonly moveUp?: () => void;
  readonly moveDown?: () => void;
  readonly archive: () => void;
  readonly rename: () => void;
  readonly regenerateTitle: () => void;
  readonly handoff: () => void;
  readonly turnIntoProject: () => void;
  readonly delete: () => void;
  readonly openCustomSnooze: () => void;
  readonly snooze: (snoozedUntil: string) => void;
  readonly snoozeExpired: () => void;
}

/** Routes a menu event id to its handler; shared by the list row and the open thread. */
export function runThreadMenuEvent(
  event: string,
  handlers: ThreadMenuHandlers,
  snooze: {
    readonly displayedPresets: SnoozePresets;
    readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
    readonly now: Date;
  },
): void {
  switch (event) {
    case "new-thread-on-branch":
      return handlers.newThreadOnBranch?.();
    case "copy-thread":
      return handlers.copyThread();
    case "copy-thread-id":
      return handlers.copyThreadId();
    case "settle":
      return handlers.settle();
    case "unsettle":
      return handlers.unsettle();
    case "unsnooze":
      return handlers.unsnooze();
    case "pin":
      return handlers.pin();
    case "unpin":
      return handlers.unpin();
    case "auto-settle:enabled":
      return handlers.setAutoSettle(true);
    case "auto-settle:disabled":
      return handlers.setAutoSettle(false);
    case "arrange":
      return handlers.arrange?.();
    case "move-up":
      return handlers.moveUp?.();
    case "move-down":
      return handlers.moveDown?.();
    case "archive":
      return handlers.archive();
    case "rename":
      return handlers.rename();
    case "regenerate-title":
      return handlers.regenerateTitle();
    case "handoff":
      return handlers.handoff();
    case "turn-into-project":
      return handlers.turnIntoProject();
    case "delete":
      return handlers.delete();
    case "snooze:custom":
      return handlers.openCustomSnooze();
  }
  const selection = resolveThreadListV2SnoozeMenuSelection({
    event,
    displayedPresets: snooze.displayedPresets,
    now: snooze.now,
    presets: snooze.presets,
  });
  if (selection._tag === "selected") handlers.snooze(selection.preset.snoozedUntil);
  else if (selection._tag === "expired") handlers.snoozeExpired();
}

/** The header menus take their own item shape; ids stay the same so one dispatcher serves both. */
export function menuActionsToAppBarItems(
  actions: ReadonlyArray<MenuAction>,
  onAction: (id: string) => void,
): AppBarMenuItem[] {
  return actions.map((action): AppBarMenuItem => {
    if (action.subactions) {
      return {
        id: action.id ?? action.title,
        title: action.title,
        icon: action.image,
        items: menuActionsToAppBarItems(action.subactions, onAction),
      };
    }
    const id = action.id ?? action.title;
    return {
      id,
      title: action.title,
      subtitle: action.subtitle,
      icon: action.image,
      disabled: action.attributes?.disabled === true,
      selected: action.state === "on",
      onPress: () => onAction(id),
    };
  });
}
