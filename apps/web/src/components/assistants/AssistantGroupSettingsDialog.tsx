import { useAtomValue } from "@effect/atom-react";
import { assistantGroupLatestSeq } from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_TEAM_MEMORIES_MAX,
  ASSISTANT_TEAM_MEMORY_MAX_CHARS,
  type AssistantGroupConversationAction,
  type AssistantTeam,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { sameProjects } from "@t3tools/client-runtime/assistantSections";
import {
  MessageSquarePlusIcon,
  PlusIcon,
  ShrinkIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  useAssistantEntries,
  useAssistantGroupActions,
  useAssistantGroupChat,
  useAssistantTeamActions,
} from "../../state/assistants";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { GroupProjectsSection } from "./GroupProjectsSection";
import {
  assistantGroupSettingsAtom,
  type AssistantGroupSettingsTarget,
} from "./assistantTeamState";

export function AssistantGroupSettingsHost() {
  const target = useAtomValue(assistantGroupSettingsAtom);
  if (target === null) return null;
  return (
    <AssistantGroupSettingsDialog
      key={`${target.environmentId}:${target.teamId}`}
      target={target}
      onClose={() => appAtomRegistry.set(assistantGroupSettingsAtom, null)}
    />
  );
}

function Field(props: {
  readonly htmlFor: string;
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={props.htmlFor}>{props.label}</Label>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </div>
  );
}

function ConversationRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly description: string;
  readonly destructive?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{props.label}</span>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </div>
      <Button
        size="sm"
        variant={props.destructive === true ? "destructive-outline" : "outline"}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.icon}
        {props.label}
      </Button>
    </li>
  );
}

function AssistantGroupSettingsDialog(props: {
  readonly target: AssistantGroupSettingsTarget;
  readonly onClose: () => void;
}) {
  const { environmentId, teamId } = props.target;
  const { teams } = useAssistantEntries();
  const team: AssistantTeam | undefined = teams.find(
    (entry) => entry.environmentId === environmentId && entry.team.id === teamId,
  )?.team;
  if (team === undefined) return null;
  return <SettingsForm environmentId={environmentId} team={team} onClose={props.onClose} />;
}

function SettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly onClose: () => void;
}) {
  const { environmentId, team } = props;
  const teamActions = useAssistantTeamActions(environmentId);
  const groupActions = useAssistantGroupActions(environmentId);
  const chat = useAssistantGroupChat(environmentId, team.id);
  const [instructions, setInstructions] = useState(team.instructions ?? "");
  // Each row keeps its own key, so removing one does not shift the text typed into the others.
  const [rows, setRows] = useState<ReadonlyArray<{ readonly key: number; readonly text: string }>>(
    (team.memories ?? []).map((text, key) => ({ key, text })),
  );
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>(team.projectIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const working = team.chat?.working === true;
  const latest = chat === null ? 0 : assistantGroupLatestSeq(chat);
  const endsWithBoundary =
    chat !== null &&
    [...chat.messages.values()].some(
      (message) => message.seq === latest && message.kind === "boundary",
    );
  const idleFor = busy || working || !groupActions.canConverse;
  const kept = rows.map((row) => row.text.trim()).filter((text) => text !== "");
  const changed =
    instructions.trim() !== (team.instructions ?? "") ||
    JSON.stringify(kept) !== JSON.stringify(team.memories ?? []) ||
    !sameProjects(projectIds, team.projectIds);

  const save = async () => {
    setBusy(true);
    setError(null);
    const reply = await teamActions.update({
      teamId: team.id,
      instructions: instructions.trim(),
      memories: kept,
      ...(sameProjects(projectIds, team.projectIds) ? {} : { projectIds }),
    });
    setBusy(false);
    if (!reply.ok) return setError(reply.message);
    props.onClose();
  };

  const converse = async (action: AssistantGroupConversationAction) => {
    setBusy(true);
    setError(null);
    const reply = await groupActions.conversation(team.id, action);
    setBusy(false);
    if (!reply.ok) return setError(reply.message);
    props.onClose();
  };

  const clear = async () => {
    const confirmed = await requestConfirmDialog(
      `Clear the history of ${team.name}?\nEvery message, task and file in this chat is deleted. Members keep their own conversations. This cannot be undone.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    await converse("clear");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{team.name} settings</DialogTitle>
          <DialogDescription>
            What every member knows about this group, and how its chat starts over.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-6">
            <Field
              htmlFor="group-instructions"
              label="Group instructions"
              description="Sent to every member with each task, on top of its own instructions."
            >
              <Textarea
                id="group-instructions"
                rows={4}
                value={instructions}
                maxLength={ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <p className="text-end text-xs text-muted-foreground tabular-nums">
                {instructions.length.toLocaleString()} /{" "}
                {ASSISTANT_TEAM_INSTRUCTIONS_MAX_CHARS.toLocaleString()}
              </p>
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Group memories</legend>
              <p className="text-xs text-muted-foreground">
                Short facts every member should remember, up to {ASSISTANT_TEAM_MEMORIES_MAX}.
              </p>
              <ul className="flex flex-col gap-1.5">
                {rows.map((row, index) => (
                  <li key={row.key} className="flex items-center gap-1.5">
                    <Input
                      aria-label={`Memory ${index + 1}`}
                      value={row.text}
                      maxLength={ASSISTANT_TEAM_MEMORY_MAX_CHARS}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry) =>
                            entry.key === row.key ? { ...entry, text: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={`Remove memory ${index + 1}`}
                      onClick={() =>
                        setRows((current) => current.filter((entry) => entry.key !== row.key))
                      }
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rows.length >= ASSISTANT_TEAM_MEMORIES_MAX}
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      { key: Math.max(-1, ...current.map((entry) => entry.key)) + 1, text: "" },
                    ])
                  }
                >
                  <PlusIcon />
                  Add memory
                </Button>
              </div>
            </fieldset>
            <GroupProjectsSection
              environmentId={environmentId}
              team={team}
              picked={projectIds}
              onChange={setProjectIds}
            />
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Conversation</h3>
              <p className="text-xs text-muted-foreground">
                {working
                  ? "The group is working. Stop its tasks to change the conversation."
                  : "Start over without losing the chat: older messages stay above a divider."}
              </p>
              <ul className="flex flex-col divide-y divide-foreground/12">
                <ConversationRow
                  icon={<MessageSquarePlusIcon />}
                  label="New conversation"
                  description="Members read only what comes next. The summary starts over."
                  disabled={idleFor}
                  onClick={() => void converse("new")}
                />
                <ConversationRow
                  icon={<ShrinkIcon />}
                  label="Compact context"
                  description="Summarizes the chat so far, then starts a new conversation from the summary."
                  disabled={idleFor}
                  onClick={() => void converse("compact")}
                />
                {endsWithBoundary ? (
                  <ConversationRow
                    icon={<Undo2Icon />}
                    label="Undo divider"
                    description="Removes the latest divider while nothing follows it."
                    disabled={busy || !groupActions.canConverse}
                    onClick={() => void converse("undo")}
                  />
                ) : null}
                <ConversationRow
                  icon={<Trash2Icon />}
                  label="Clear history"
                  description="Deletes every message, task and file of this chat."
                  destructive
                  disabled={idleFor}
                  onClick={() => void clear()}
                />
              </ul>
            </section>
            {error === null ? null : (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !changed || !teamActions.canAct} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
