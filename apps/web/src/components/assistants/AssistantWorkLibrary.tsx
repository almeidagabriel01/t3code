import {
  AuthOrchestrationOperateScope,
  type Assistant,
  type AssistantLibraryFile,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ExternalLinkIcon, FileIcon, FolderOpenIcon } from "lucide-react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useAssistantLibrary } from "../../state/assistants";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

const NO_EDITORS: ReadonlyArray<never> = [];

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files it handed to other assistants or received from them, from the shared folder. */
export function AssistantWorkLibrary(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: Assistant;
  readonly nowMs: number;
}) {
  const { environmentId } = props;
  const library = useAssistantLibrary(environmentId, props.assistant.id);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const availableEditors = config?.availableEditors ?? NO_EDITORS;
  const canReveal =
    canOperate &&
    config?.shellRevealInFileManager === true &&
    availableEditors.includes("file-manager");
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const report = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  const open = async (file: AssistantLibraryFile) => {
    const result = await openInPreferredEditor(file.path);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      report("Unable to open file", squashAtomCommandFailure(result));
  };
  const reveal = async (file: AssistantLibraryFile) => {
    const result = await openInEditor({
      environmentId,
      input: { cwd: file.path, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      report("Unable to reveal file", squashAtomCommandFailure(result));
  };

  if (library.error !== null) {
    return (
      <p className="text-xs text-destructive-foreground">
        Could not load its files: {library.error}
      </p>
    );
  }
  const files = library.data?.files ?? [];
  if (files.length === 0) {
    return (
      <p className="rounded-md px-2 py-1.5 text-xs text-muted-foreground">
        {library.data === null
          ? "Loading its files."
          : "No files yet. Files it hands to other assistants, or gets from them, show up here."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="m-0 flex list-none flex-col p-0">
        {files.map((file) => (
          <li
            key={file.path}
            data-testid="assistant-library-file"
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
          >
            <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{file.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {file.direction === "sent"
                  ? "Sent"
                  : `Received${file.from === null ? "" : ` from ${file.from}`}`}
                {` · ${sizeLabel(file.size)} · ${formatRelativeTimeLabel(file.savedAt, props.nowMs)}`}
              </span>
            </span>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Open ${file.name}`}
              disabled={!canOperate}
              onClick={() => void open(file)}
            >
              <ExternalLinkIcon />
            </Button>
            {canReveal ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Reveal ${file.name}`}
                onClick={() => void reveal(file)}
              >
                <FolderOpenIcon />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {library.data?.truncated ? (
        <p className="px-2 text-xs text-muted-foreground">Showing the newest files.</p>
      ) : null}
    </div>
  );
}
