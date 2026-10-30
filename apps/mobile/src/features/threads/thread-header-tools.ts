import type { ProjectScript } from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";

/** Terminal and Files as menu items, for the compact header where they do not get their own buttons. */
export function buildThreadToolsMenuItems(input: {
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
  readonly onOpenFiles: () => void;
}): AppBarMenuItem[] {
  const terminal: AppBarMenuItem = input.canOpenTerminal
    ? {
        id: "terminal",
        title: "Terminal",
        icon: "terminal",
        items: [
          ...input.projectScripts.map((script) => ({
            id: `terminal-script:${script.id}`,
            title: projectScriptMenuLabel(script),
            subtitle: script.command,
            icon: projectScriptMenuIcon(script.icon),
            disabled: !input.canOperateTerminal,
            onPress: () => void input.onRunProjectScript(script),
          })),
          ...(input.projectScripts.length === 0
            ? [
                {
                  id: "terminal-no-scripts",
                  title: "No project scripts",
                  subtitle: "This project has no saved scripts yet",
                  icon: "play",
                  disabled: true,
                  onPress: () => {},
                },
              ]
            : []),
          ...input.terminalSessions.map((session) => ({
            id: `terminal-session:${session.terminalId}`,
            title: session.displayLabel,
            subtitle: [
              getTerminalStatusLabel({
                status: session.status,
                hasRunningSubprocess: session.hasRunningSubprocess,
              }),
              basename(session.cwd),
            ]
              .filter(Boolean)
              .join(" · "),
            icon: "terminal",
            onPress: () => input.onOpenTerminal(session.terminalId),
          })),
          {
            id: "terminal-new",
            title: "Open new terminal",
            subtitle: "Start another shell for this thread",
            icon: "plus",
            disabled: !input.canOperateTerminal,
            onPress: input.onOpenNewTerminal,
          },
        ],
      }
    : {
        id: "terminal",
        title: "Terminal",
        icon: "terminal",
        disabled: true,
        onPress: () => {},
      };
  return [
    terminal,
    {
      id: "files",
      title: "Files",
      icon: "folder",
      disabled: !input.canOpenFiles,
      onPress: input.onOpenFiles,
    },
  ];
}
