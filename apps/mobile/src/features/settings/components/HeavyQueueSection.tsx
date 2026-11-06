import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type HeavyQueueEntry } from "@t3tools/contracts";
import { Alert } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useThreadShell } from "../../../state/entities";
import { heavyQueueEnvironment, useHeavyQueueEntries } from "../../../state/heavyQueue";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).findLast((part) => part.length > 0) ?? cwd;
}

function QueueEntryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: HeavyQueueEntry;
  /** 1-based place among the waiters; null for the running entry. */
  readonly position: number | null;
  readonly canChange: boolean;
  readonly onPromote: () => void;
  readonly onRemove: () => void;
}) {
  const { entry, position } = props;
  const thread = useThreadShell(
    entry.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, ThreadId.make(entry.threadId)),
  );
  const origin = thread?.title ?? folderName(entry.cwd);
  const startedAt = entry.startedAt === null ? null : new Date(entry.startedAt);
  return (
    <>
      <ListRowLayout
        icon={position === null ? "play" : "hourglass"}
        label={entry.label}
        description={
          startedAt === null
            ? origin
            : `${origin} · Running since ${startedAt.toLocaleTimeString([], { timeStyle: "short" })}`
        }
        {...(position === null ? {} : { detail: `#${position}` })}
      />
      {position !== null && position > 1 ? (
        <SettingsActionRow
          icon="arrow.up"
          label="Run next"
          disabled={!props.canChange}
          onPress={props.onPromote}
        />
      ) : null}
      {position !== null ? (
        <SettingsActionRow
          icon="trash"
          label="Remove"
          tone="danger"
          disabled={!props.canChange}
          onPress={props.onRemove}
        />
      ) : null}
    </>
  );
}

export function HeavyQueueSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const entries = useHeavyQueueEntries(environmentId);
  const canPromote = useAtomValue(heavyQueueEnvironment.promote.permissionAtom(environmentId));
  const canCancel = useAtomValue(heavyQueueEnvironment.cancel.permissionAtom(environmentId));
  const promote = useAtomCommand(heavyQueueEnvironment.promote);
  const cancel = useAtomCommand(heavyQueueEnvironment.cancel);
  return (
    <SettingsSection
      title="Heavy work queue"
      footer="Agents queue tests, builds and simulators here when the Mac is busy; one runs at a time."
    >
      {entries.length === 0 ? <ListRowLayout icon="checkmark" label="Nothing queued." /> : null}
      {entries.map((entry, index) => {
        const position =
          entry.startedAt === null
            ? entries.slice(0, index + 1).filter((e) => e.startedAt === null).length
            : null;
        return (
          <QueueEntryRow
            key={entry.id}
            environmentId={environmentId}
            entry={entry}
            position={position}
            canChange={canPromote && canCancel}
            onPromote={() => void promote({ environmentId, input: { id: entry.id } })}
            onRemove={() =>
              Alert.alert("Remove from the queue?", entry.label, [
                { text: "Keep", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () => void cancel({ environmentId, input: { id: entry.id } }),
                },
              ])
            }
          />
        );
      })}
    </SettingsSection>
  );
}
