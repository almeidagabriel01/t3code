import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

type ThreadShortcutListItem = ThreadListV2ListItem | { readonly type: "v2-show-more" };

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

/** `leading` (the assistants section's rows) counts first; the list skips threads it already gave. */
export function threadJumpTarget(
  items: ReadonlyArray<ThreadShortcutListItem>,
  command: HardwareKeyboardCommand,
  leading: ReadonlyArray<EnvironmentThreadShell> = [],
) {
  let index = threadJumpIndex(command);
  if (index < 0) return null;
  if (index < leading.length) return leading[index]!;
  index -= leading.length;
  const taken = new Set(leading.map((thread) => `${thread.environmentId}:${thread.id}`));
  for (const item of items) {
    const thread = item.type === "v2-thread" ? item.item.thread : null;
    if (thread === null || taken.has(`${thread.environmentId}:${thread.id}`)) continue;
    if (index-- === 0) return thread;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
  leading?: ReadonlyArray<EnvironmentThreadShell>,
) {
  const jumpToThread = (command: HardwareKeyboardCommand) => {
    const thread = threadJumpTarget(items, command, leading);
    if (thread !== null) onSelectThread(thread);
    return true;
  };
  useHardwareKeyboardCommand(THREAD_JUMP_KEYBINDING_COMMANDS, jumpToThread);
}
