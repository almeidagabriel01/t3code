import { useAtomValue } from "@effect/atom-react";
import {
  ASSISTANT_TEAM_NAME_MAX_LENGTH,
  assistantTeamProblem,
  type AssistantId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { NO_LEAD_LABEL, teamMemberChoices } from "@t3tools/client-runtime/assistantTeam";
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
import { AssistantGroupRoutinesHost } from "./AssistantGroupRoutinesDialog";
import { AssistantGroupSettingsHost } from "./AssistantGroupSettingsDialog";
import { ProjectAssistantAccessHost } from "./ProjectAssistantAccessDialog";
import { assistantTeamDialogAtom, type AssistantTeamDialogTarget } from "./assistantTeamState";

const NO_LEAD_VALUE = "__nobody__";

export function AssistantTeamDialogHost() {
  const target = useAtomValue(assistantTeamDialogAtom);
  return (
    <>
      {target === null ? null : (
        <AssistantTeamDialog
          key={`${target.environmentId}:${target.teamId}`}
          target={target}
          onClose={() => appAtomRegistry.set(assistantTeamDialogAtom, null)}
        />
      )}
      <AssistantGroupSettingsHost />
      <AssistantGroupRoutinesHost />
      <ProjectAssistantAccessHost />
    </>
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
  const [leadId, setLeadId] = useState<AssistantId | null>(team?.leadId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveLead = leadId !== null && memberIds.includes(leadId) ? leadId : null;
  const problem = assistantTeamProblem({ memberIds, leadId: effectiveLead });
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
    const reply = team
      ? await actions.update({
          teamId: team.id,
          name: name.trim(),
          memberIds,
          leadId: effectiveLead,
        })
      : await actions.create({
          name: name.trim(),
          memberIds,
          leadId: effectiveLead,
        });
    setSaving(false);
    if (!reply.ok) return setError(reply.message);
    props.onClose();
  };

  const remove = async () => {
    if (team === null) return;
    const confirmed = await requestConfirmDialog(
      `Delete the group ${team.name}?\nIts members stay; they just stop being teammates.`,
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
            Members can message each other in any direction. A lead is optional.
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
                <Label htmlFor="assistant-team-lead">Lead</Label>
                <p className="text-xs text-muted-foreground">
                  Optional. Routes requests that mention no one. It does not change who may message
                  whom.
                </p>
              </div>
              <Select
                value={effectiveLead ?? NO_LEAD_VALUE}
                onValueChange={(next) =>
                  setLeadId(next === NO_LEAD_VALUE ? null : (next as AssistantId))
                }
              >
                <SelectTrigger id="assistant-team-lead" aria-label="Lead">
                  <SelectValue>
                    {choices.find((assistant) => assistant.id === effectiveLead)?.name ??
                      NO_LEAD_LABEL}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={NO_LEAD_VALUE}>
                    {NO_LEAD_LABEL}
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
