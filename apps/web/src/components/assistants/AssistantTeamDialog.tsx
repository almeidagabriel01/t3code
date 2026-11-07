import { useAtomValue } from "@effect/atom-react";
import {
  ASSISTANT_TEAM_NAME_MAX_LENGTH,
  ASSISTANT_TEAM_TITLE_MAX_LENGTH,
  assistantTeamProblem,
  type AssistantId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { NO_LEADER_LABEL, teamMemberChoices } from "@t3tools/client-runtime/assistantTeam";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  useAssistantEntries,
  useAssistantsEnvironmentIds,
  useAssistantTeamActions,
} from "../../state/assistants";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AssistantAvatar } from "./assistantPresentation";
import { assistantTeamDialogAtom, type AssistantTeamDialogTarget } from "./assistantTeamState";

const NO_LEADER_VALUE = "__nobody__";

export function AssistantTeamDialogHost() {
  const target = useAtomValue(assistantTeamDialogAtom);
  if (target === null) return null;
  return (
    <AssistantTeamDialog
      key={`${target.environmentId}:${target.teamId}`}
      target={target}
      onClose={() => appAtomRegistry.set(assistantTeamDialogAtom, null)}
    />
  );
}

function AssistantTeamDialog(props: {
  readonly target: AssistantTeamDialogTarget;
  readonly onClose: () => void;
}) {
  const environmentIds = useAssistantsEnvironmentIds();
  const { active, archived, teams } = useAssistantEntries();
  const existing =
    props.target.teamId === null
      ? null
      : (teams.find(
          (entry) =>
            entry.team.id === props.target.teamId &&
            (props.target.environmentId === null ||
              entry.environmentId === props.target.environmentId),
        ) ?? null);
  const team = existing?.team ?? null;
  const environmentId: EnvironmentId | null =
    existing?.environmentId ?? props.target.environmentId ?? environmentIds[0] ?? null;
  const actions = useAssistantTeamActions((environmentId ?? "") as EnvironmentId);
  const choices = teamMemberChoices(
    [...active, ...archived]
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.assistant),
    team,
  );

  const [name, setName] = useState(team?.name ?? "");
  const [memberIds, setMemberIds] = useState<ReadonlyArray<AssistantId>>(team?.memberIds ?? []);
  const [leaderId, setLeaderId] = useState<AssistantId | null>(team?.leaderId ?? null);
  const [leaderTitle, setLeaderTitle] = useState(team?.leaderTitle ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveLeader = leaderId !== null && memberIds.includes(leaderId) ? leaderId : null;
  const problem = assistantTeamProblem({ memberIds, leaderId: effectiveLeader, leaderTitle: "" });
  const canSave =
    !saving && actions.canAct && environmentId !== null && name.trim() !== "" && problem === null;

  const toggle = (id: AssistantId, checked: boolean) =>
    setMemberIds((current) =>
      checked ? [...current, id] : current.filter((memberId) => memberId !== id),
    );

  const save = async () => {
    if (environmentId === null) return;
    setSaving(true);
    setError(null);
    const title = effectiveLeader === null ? null : leaderTitle.trim() || null;
    const reply = team
      ? await actions.update({
          teamId: team.id,
          name: name.trim(),
          memberIds,
          leaderId: effectiveLeader,
          leaderTitle: title,
        })
      : await actions.create({
          name: name.trim(),
          memberIds,
          leaderId: effectiveLeader,
          leaderTitle: title,
        });
    setSaving(false);
    if (!reply.ok) return setError(reply.message);
    props.onClose();
  };

  const remove = async () => {
    if (team === null) return;
    const confirmed = await requestConfirmDialog(
      `Delete the group ${team.name}?\nIts members stay; they just stop being able to message each other as a team.`,
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    setSaving(true);
    const reply = await actions.remove(team.id);
    setSaving(false);
    if (!reply.ok) return setError(reply.message);
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{team ? `${team.name} group` : "New group"}</DialogTitle>
          <DialogDescription>
            Members can message each other in any direction, and you can follow what they say. A
            leader is optional.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) void save();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assistant-team-name">Name</Label>
              <Input
                id="assistant-team-name"
                placeholder="Growth, Finance…"
                value={name}
                maxLength={ASSISTANT_TEAM_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Members</legend>
              <p className="text-xs text-muted-foreground">
                Optional: a group can start empty and members join later.
              </p>
              <ul className="flex flex-col gap-0.5">
                {choices.map((assistant) => (
                  <li key={assistant.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/8">
                      <Checkbox
                        aria-label={assistant.name}
                        checked={memberIds.includes(assistant.id)}
                        onCheckedChange={(checked) => toggle(assistant.id, Boolean(checked))}
                      />
                      <AssistantAvatar assistant={assistant} className="size-6" />
                      <span className="truncate">{assistant.name}</span>
                      {assistant.archivedAt === null ? null : (
                        <span className="text-xs text-muted-foreground">archived</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="assistant-team-leader">Leader</Label>
                <p className="text-xs text-muted-foreground">
                  Optional. Teammates are told to report their results to the leader. It does not
                  change who may message whom.
                </p>
              </div>
              <Select
                value={effectiveLeader ?? NO_LEADER_VALUE}
                onValueChange={(next) =>
                  setLeaderId(next === NO_LEADER_VALUE ? null : (next as AssistantId))
                }
              >
                <SelectTrigger id="assistant-team-leader" aria-label="Leader">
                  <SelectValue>
                    {choices.find((assistant) => assistant.id === effectiveLeader)?.name ??
                      NO_LEADER_LABEL}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={NO_LEADER_VALUE}>
                    {NO_LEADER_LABEL}
                  </SelectItem>
                  {choices
                    .filter((assistant) => memberIds.includes(assistant.id))
                    .map((assistant) => (
                      <SelectItem hideIndicator key={assistant.id} value={assistant.id}>
                        {assistant.name}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            </div>
            {effectiveLeader === null ? null : (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="assistant-team-leader-title">Leader title</Label>
                  <p className="text-xs text-muted-foreground">
                    CEO, CFO, Head of Research… Agents and the team view show it.
                  </p>
                </div>
                <Input
                  id="assistant-team-leader-title"
                  placeholder="CEO"
                  value={leaderTitle}
                  maxLength={ASSISTANT_TEAM_TITLE_MAX_LENGTH}
                  onChange={(event) => setLeaderTitle(event.target.value)}
                />
              </div>
            )}
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {team ? (
            <Button
              variant="destructive-outline"
              disabled={saving || !actions.canAct}
              onClick={() => void remove()}
            >
              Delete group
            </Button>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {team ? "Save" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
