import { useAtomValue } from "@effect/atom-react";
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_LENGTH,
  ASSISTANT_ROLE_MAX_LENGTH,
  assistantHandleFromName,
  AssistantHandle,
  BudgetPeriod,
  DEFAULT_ASSISTANT_AUTONOMY,
  type AssistantAutonomy,
  type AssistantTeam,
  type AssistantTeamId,
  type AssistantToolAccess,
  type AssistantWorkspace,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import {
  connectorDraftsFrom,
  connectorDraftsProblem,
  connectorInputsFrom,
  connectorsEqual,
  type ConnectorDraft,
} from "@t3tools/client-runtime/assistantConnectors";
import {
  ALL_PROJECTS,
  assistantProjectFields,
  assistantProjectSelection,
  homeAfterPick,
  projectPickerRows,
  sameProjects,
  toggleAssistantProject,
} from "@t3tools/client-runtime/assistantSections";
import { sameAssistantAutonomy } from "@t3tools/client-runtime/autonomy";
import { createModelSelection } from "@t3tools/shared/model";
import { Link, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { BrainIcon } from "lucide-react";
import { useState } from "react";

import { assistantRobotLook, newAssistantLook } from "@t3tools/client-runtime/assistantRobot";
import { uploadStandaloneAttachment } from "../../lib/attachmentUploadQueue";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantSpend,
  useAssistantsEnvironmentIds,
  useAssistantTeamActions,
} from "../../state/assistants";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { validateMemorySettingsSearch } from "../settings/MemorySettings.logic";
import { cn } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTraitsSectionVisibility, TraitsPicker } from "../chat/TraitsPicker";
import { BUDGET_PERIOD_LABELS } from "../settings/ProviderBudgetSection";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { AssistantAvatarPicker, type AvatarDraft } from "./AssistantAvatarPicker";
import { AssistantConnectorsField } from "./AssistantConnectorsField";
import { AssistantNotifications } from "./AssistantNotifications";
import { AssistantWorkspaceField } from "./AssistantWorkspaceField";
import { AssistantSchedules } from "./AssistantSchedules";
import { AssistantWatches } from "./AssistantWatches";
import { budgetFromDraft, budgetToDraft, spendLine, type BudgetDraft } from "./assistantBudget";
import { assistantDialogAtom, type AssistantDialogTarget } from "./assistantDialogState";
import { useAssistantFlows } from "./useAssistantFlows";
import { TOOL_ACCESS_OPTIONS, toolAccessLabel } from "./assistantPresentation";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const isValidHandle = Schema.is(AssistantHandle);
/** Renders the create/edit dialog once, wherever it was asked for. */
export function AssistantDialogHost() {
  const target = useAtomValue(assistantDialogAtom);
  if (target === null) return null;
  return (
    <AssistantDialog
      key={`${target.environmentId}:${target.assistantId}`}
      target={target}
      onClose={() => appAtomRegistry.set(assistantDialogAtom, null)}
    />
  );
}

function FieldLabel(props: {
  readonly htmlFor: string;
  readonly label: string;
  readonly description: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      <p className="text-xs text-muted-foreground">{props.description}</p>
    </div>
  );
}

function AskBeforeActingField(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor="assistant-ask-before-acting">Ask before acting</Label>
        <p className="text-xs text-muted-foreground">
          Before this assistant sends anything into another conversation, it asks you here and waits
          for your approval.
        </p>
      </div>
      <Switch
        id="assistant-ask-before-acting"
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        aria-label="Ask before acting"
      />
    </div>
  );
}

function BudgetFields(props: {
  readonly draft: BudgetDraft;
  readonly onChange: (patch: Partial<BudgetDraft>) => void;
  readonly spent: string | null;
}) {
  const { draft } = props;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="assistant-limit">Spending limit</Label>
          <p className="text-xs text-muted-foreground">
            Counts every conversation it has had, priced from this app's own turns.
          </p>
        </div>
        <Switch
          id="assistant-limit"
          checked={draft.enabled}
          onCheckedChange={(checked) => props.onChange({ enabled: Boolean(checked) })}
          aria-label="Limit spending"
        />
      </div>
      {props.spent ? <p className="text-xs text-muted-foreground">{props.spent}</p> : null}
      {draft.enabled ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assistant-limit-amount">Amount (USD)</Label>
              <Input
                id="assistant-limit-amount"
                inputMode="decimal"
                placeholder="10"
                value={draft.amount}
                onChange={(event) => props.onChange({ amount: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="assistant-limit-warn">Warn at (%)</Label>
              <Input
                id="assistant-limit-warn"
                inputMode="numeric"
                value={draft.warnAtPercent}
                onChange={(event) => props.onChange({ warnAtPercent: event.target.value })}
              />
            </div>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Period</legend>
            <RadioGroup
              aria-label="Limit period"
              value={draft.period}
              onValueChange={(value) => props.onChange({ period: value as BudgetPeriod })}
            >
              {BudgetPeriod.literals.map((period) => (
                <label
                  key={period}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8"
                >
                  <Radio value={period} />
                  {BUDGET_PERIOD_LABELS[period]}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="assistant-limit-stop">Stop when reached</Label>
              <p className="text-xs text-muted-foreground">
                New turns are refused until the period resets. Turns already running finish.
              </p>
            </div>
            <Switch
              id="assistant-limit-stop"
              checked={draft.block}
              onCheckedChange={(checked) => props.onChange({ block: Boolean(checked) })}
              aria-label="Stop when reached"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function AssistantDialog(props: {
  readonly target: AssistantDialogTarget;
  readonly onClose: () => void;
}) {
  const environmentIds = useAssistantsEnvironmentIds();
  const { environments } = useEnvironments();
  const { active, archived } = useAssistantEntries();
  const existing =
    props.target.assistantId === null
      ? null
      : ([...active, ...archived].find(
          (entry) =>
            entry.assistant.id === props.target.assistantId &&
            (props.target.environmentId === null ||
              entry.environmentId === props.target.environmentId),
        ) ?? null);
  const assistant = existing?.assistant ?? null;
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(
    props.target.environmentId,
  );
  const environmentId = existing?.environmentId ?? pickedEnvironmentId ?? environmentIds[0] ?? null;
  const actions = useAssistantActions((environmentId ?? "") as EnvironmentId);
  const teamActions = useAssistantTeamActions((environmentId ?? "") as EnvironmentId);
  const { teams: teamEntries } = useAssistantEntries();
  const teams = teamEntries
    .filter((entry) => entry.environmentId === environmentId)
    .map((entry) => entry.team);
  const { openConversation } = useAssistantFlows((environmentId ?? "") as EnvironmentId);
  const router = useRouter();

  const [name, setName] = useState(assistant?.name ?? "");
  const [handleInput, setHandleInput] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(assistant?.instructions ?? "");
  const [toolAccess, setToolAccess] = useState<AssistantToolAccess>(
    assistant?.toolAccess ?? "workspace-write",
  );
  const [askBeforeActing, setAskBeforeActing] = useState(assistant?.askBeforeActing ?? true);
  const [workspace, setWorkspace] = useState<AssistantWorkspace>(assistant?.workspace ?? "host");
  const [avatar, setAvatar] = useState<AvatarDraft>(() => {
    const look = assistantRobotLook(
      assistant ?? {
        id: "new",
        avatar: { kind: "robot", ...newAssistantLook(active.length + archived.length) },
      },
    );
    return { ...look, image: assistant?.avatar?.kind === "image" ? { kind: "stored" } : null };
  });
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [connectors, setConnectors] = useState<ReadonlyArray<ConnectorDraft>>(() =>
    connectorDraftsFrom(assistant?.mcpServers ?? []),
  );
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(() =>
    assistant
      ? assistantProjectSelection(assistant)
      : props.target.preset?.projectId
        ? [props.target.preset.projectId]
        : null,
  );
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const [role, setRole] = useState(assistant?.role ?? "");
  const [budgetDraft, setBudgetDraft] = useState(() => budgetToDraft(assistant?.budget ?? null));
  const [autonomy, setAutonomy] = useState<AssistantAutonomy>(
    assistant?.autonomy ?? DEFAULT_ASSISTANT_AUTONOMY,
  );
  const spend = useAssistantSpend(
    (environmentId ?? "") as EnvironmentId,
    assistant && assistant.budget !== null ? assistant.id : null,
  );
  const [groupChoices, setGroupChoices] = useState<ReadonlyMap<AssistantTeamId, boolean>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const presetTeamId = props.target.preset?.teamId;
  const inGroup = (candidate: AssistantTeam) =>
    groupChoices.get(candidate.id) ??
    ((assistant !== null && candidate.memberIds.includes(assistant.id)) ||
      (assistant === null && candidate.id === presetTeamId));

  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const groups = useSidebarProjectGroups();
  const projectName = (candidate: (typeof projects)[number]) =>
    groups.find((group) =>
      group.memberProjects.some(
        (member) => member.environmentId === candidate.environmentId && member.id === candidate.id,
      ),
    )?.displayName ?? candidate.title;
  const effectivePicked = picked ?? [ALL_PROJECTS];
  const allPicked = effectivePicked.includes(ALL_PROJECTS);
  const pickedIds = effectivePicked as ReadonlyArray<ProjectId>;
  const effectiveProjectId =
    homeAfterPick(assistant?.projectId ?? null, pickedIds) ??
    (allPicked ? (projects[0]?.id ?? null) : null);
  const homeId = (effectiveProjectId ?? ALL_PROJECTS) as ProjectId;
  const effectiveProject = projects.find((project) => project.id === effectiveProjectId) ?? null;
  const pickerRows = projectPickerRows(
    projects
      .filter((project) => !project.isScratch)
      .map((project) => ({
        id: project.id,
        label: projectName(project),
        path: project.workspaceRoot,
      })),
  );
  const pickedLabel = pickerRows
    .filter((row) => effectivePicked.includes(row.id))
    .map((row) => row.label)
    .join(", ");
  const projectsChanged =
    assistant !== null && !sameProjects(effectivePicked, assistantProjectSelection(assistant));
  const projectOptions = projects.map((project) => ({
    id: project.id,
    label: project.isScratch ? "All projects" : projectName(project),
  }));

  const settings = useEnvironmentSettings((environmentId ?? "") as EnvironmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environmentId === null ? undefined : providersByEnvironment.get(environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const thread = useThreadShell(
    environmentId !== null && assistant?.threadId
      ? scopeThreadRef(environmentId, assistant.threadId)
      : null,
  );
  const defaultModel = (() => {
    const stored = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
    return stored ? resolveEffectiveDefaultModelSelection(settings, providers, stored) : null;
  })();
  const currentModel: ModelSelection | null = thread?.modelSelection ?? defaultModel;
  const model = pickedModel ?? currentModel;
  const entries = providerInstanceEntriesFor(providers, settings, effectiveProjectId);
  const modelEntry =
    model === null ? undefined : entries.find((entry) => entry.instanceId === model.instanceId);
  const traits =
    model === null || modelEntry === undefined
      ? null
      : {
          provider: modelEntry.driverKind,
          models: modelEntry.models,
          model: model.model,
          modelOptions: model.options ?? [],
          allowPromptInjectedEffort: false,
          planModeEnabled: settings.planModeEnabled || selectsPlanAgent(model.options),
        };

  const advancedSummary = [
    toolAccessLabel(toolAccess),
    workspace === "host" ? "This Mac" : "Sandbox container",
    budgetDraft.enabled
      ? budgetDraft.amount.trim() === ""
        ? "spending limit"
        : `$${budgetDraft.amount.trim()} limit`
      : "no spending limit",
    connectors.length === 0
      ? "no connectors"
      : `${connectors.length} connector${connectors.length === 1 ? "" : "s"}`,
    askBeforeActing ? "asks before messaging other threads" : "messages other threads freely",
  ].join(" · ");

  const derivedHandle = assistantHandleFromName(name) ?? "";
  const handle = handleInput ?? (assistant ? assistant.handle : derivedHandle);
  const handleValid = isValidHandle(handle);
  const projectChanged =
    assistant !== null &&
    (allPicked
      ? assistant.scope !== "all"
      : effectiveProjectId !== null && effectiveProjectId !== assistant.projectId);
  const canSave =
    !saving &&
    environmentId !== null &&
    actions.canAct &&
    name.trim().length > 0 &&
    handleValid &&
    (allPicked || effectiveProjectId !== null);

  const save = async () => {
    if (!canSave) return;
    const budget = budgetFromDraft(budgetDraft, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!budget.ok) return setError(budget.message);
    const connectorsChanged = !connectorsEqual(
      connectors,
      connectorDraftsFrom(assistant?.mcpServers ?? []),
    );
    const connectorProblem = connectorsChanged ? connectorDraftsProblem(connectors) : null;
    if (connectorProblem !== null) return setError(connectorProblem);
    const robotAvatar = { kind: "robot", hue: avatar.hue, variant: avatar.variant } as const;
    const pendingFile = avatar.image?.kind === "file" ? avatar.image.file : null;
    setSaving(true);
    setError(null);
    const trimmedName = name.trim();
    const reply = assistant
      ? await actions.update({
          assistantId: assistant.id,
          ...(trimmedName !== assistant.name ? { name: trimmedName } : {}),
          ...(handle !== assistant.handle ? { handle } : {}),
          ...(projectsChanged ? assistantProjectFields(pickedIds, homeId) : {}),
          ...(pickedModel ? { modelSelection: pickedModel } : {}),
          ...(instructions !== assistant.instructions ? { instructions } : {}),
          ...(toolAccess !== assistant.toolAccess ? { toolAccess } : {}),
          ...(askBeforeActing !== assistant.askBeforeActing ? { askBeforeActing } : {}),
          ...(workspace !== assistant.workspace ? { workspace } : {}),
          ...(avatarTouched && pendingFile === null ? { avatar: robotAvatar } : {}),
          ...(connectorsChanged ? { mcpServers: connectorInputsFrom(connectors) } : {}),
          ...(role.trim() !== assistant.role ? { role: role.trim() } : {}),
          budget: budget.budget,
          ...(sameAssistantAutonomy(autonomy, assistant.autonomy) ? {} : { autonomy }),
        })
      : await actions.create({
          name: trimmedName,
          handle,
          ...assistantProjectFields(pickedIds, homeId),
          ...(pickedModel ? { modelSelection: pickedModel } : {}),
          instructions,
          toolAccess,
          ...(askBeforeActing ? { askBeforeActing } : {}),
          ...(workspace === "host" ? {} : { workspace }),
          ...(pendingFile === null ? { avatar: robotAvatar } : {}),
          ...(connectors.length === 0 ? {} : { mcpServers: connectorInputsFrom(connectors) }),
          ...(role.trim() === "" ? {} : { role: role.trim() }),
          ...(budget.budget ? { budget: budget.budget } : {}),
          ...(sameAssistantAutonomy(autonomy, DEFAULT_ASSISTANT_AUTONOMY) ? {} : { autonomy }),
        });
    if (!reply.ok) {
      setSaving(false);
      return setError(reply.message);
    }
    // The assistant is saved; a picture or group that fails is reported without losing it.
    const problems: string[] = [];
    if (pendingFile !== null && environmentId !== null) {
      try {
        const uploaded = await uploadStandaloneAttachment(environmentId, pendingFile);
        const set = await actions.setAvatarImage({
          assistantId: reply.value.id,
          attachmentId: uploaded.attachmentId,
        });
        if (!set.ok) problems.push(set.message);
      } catch (cause) {
        problems.push(cause instanceof Error ? cause.message : "The image upload failed.");
      }
    }
    for (const candidate of teams) {
      const wasMember = candidate.memberIds.includes(reply.value.id);
      if (inGroup(candidate) === wasMember) continue;
      const result = await teamActions.update({
        teamId: candidate.id,
        memberIds: wasMember
          ? candidate.memberIds.filter((id) => id !== reply.value.id)
          : [...candidate.memberIds, reply.value.id],
        // A lead must be a member, so leaving a group as its lead clears it.
        ...(wasMember && candidate.leadId === reply.value.id ? { leadId: null } : {}),
      });
      if (!result.ok) problems.push(`${candidate.name}: ${result.message}`);
    }
    setSaving(false);
    props.onClose();
    if (problems.length > 0) {
      toastManager.add({
        type: "error",
        title: `${trimmedName} was saved, but not everything`,
        description: problems.join(" "),
      });
    }
    // Settings stays put for setting up several; elsewhere the new assistant opens to talk to it.
    if (!assistant && !router.state.location.pathname.startsWith("/settings")) {
      openConversation(reply.value);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{assistant ? `${assistant.name} settings` : "New assistant"}</DialogTitle>
          <DialogDescription>
            {assistant
              ? "Changes apply to its current conversation."
              : "A named assistant keeps one long conversation you can come back to."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="@container/assistant flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {assistant === null && environmentIds.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  htmlFor="assistant-environment"
                  label="Environment"
                  description="The server that runs this assistant."
                />
                <Select
                  value={environmentId}
                  onValueChange={(next) => {
                    setPickedEnvironmentId(next as EnvironmentId);
                    setPicked(null);
                    setPickedModel(null);
                  }}
                >
                  <SelectTrigger id="assistant-environment" aria-label="Environment">
                    <SelectValue>
                      {environments.find((entry) => entry.environmentId === environmentId)?.label ??
                        ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {environmentIds.map((id) => (
                      <SelectItem hideIndicator key={id} value={id}>
                        {environments.find((entry) => entry.environmentId === id)?.label ?? id}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <AssistantAvatarPicker
              value={avatar}
              assistant={assistant}
              onChange={(next) => {
                setAvatar(next);
                setAvatarTouched(true);
              }}
            />
            <div className="grid items-start gap-5 @md/assistant:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  htmlFor="assistant-name"
                  label="Name"
                  description="Shown in the sidebar."
                />
                <Input
                  id="assistant-name"
                  autoFocus
                  value={name}
                  maxLength={ASSISTANT_NAME_MAX_LENGTH}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel
                  htmlFor="assistant-model"
                  label="Model"
                  description={
                    assistant ? "For its current conversation." : "Starts on your default."
                  }
                />
                <div id="assistant-model">
                  {model !== null &&
                  entries.some((entry) => entry.instanceId === model.instanceId) ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={model.instanceId}
                      model={model.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        model.instanceId,
                        model.model,
                      )}
                      triggerAriaLabel="Assistant model"
                      isComposerOwned={false}
                      triggerClassName={cn(
                        SETTINGS_PICKER_TRIGGER_CLASSNAME,
                        "min-h-9 w-full text-left sm:min-h-8 sm:max-w-none",
                      )}
                      onInstanceModelChange={(instanceId, next) =>
                        setPickedModel(createModelSelection(instanceId, next))
                      }
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">No providers available</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-instructions"
                label="What should it do?"
                description="Its role and rules, in your words."
              />
              <Textarea
                id="assistant-instructions"
                rows={4}
                value={instructions}
                maxLength={ASSISTANT_INSTRUCTIONS_MAX_CHARS}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <p className="text-end text-xs text-muted-foreground tabular-nums">
                {instructions.length.toLocaleString()} /{" "}
                {ASSISTANT_INSTRUCTIONS_MAX_CHARS.toLocaleString()}
              </p>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">Groups</legend>
              <p className="text-xs text-muted-foreground">
                Members of a group can message each other.
              </p>
              {teams.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No groups yet. Create one from the Assistants page.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {teams.map((candidate) => (
                    <li key={candidate.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/8">
                        <Checkbox
                          aria-label={candidate.name}
                          checked={inGroup(candidate)}
                          onCheckedChange={(checked) =>
                            setGroupChoices((current) =>
                              new Map(current).set(candidate.id, Boolean(checked)),
                            )
                          }
                        />
                        <span className="truncate">{candidate.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-role"
                label="Role"
                description="What it is to the others, such as CEO or Engineer. Agents see it."
              />
              <Input
                id="assistant-role"
                placeholder="CEO, Engineer…"
                value={role}
                maxLength={ASSISTANT_ROLE_MAX_LENGTH}
                onChange={(event) => setRole(event.target.value)}
              />
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">Projects</legend>
              <p className="text-xs text-muted-foreground">
                All projects, or the projects it works in. Work in any other project is refused.
              </p>
              <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
                {pickerRows.map((row) => (
                  <li key={row.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/8">
                      <Checkbox
                        aria-label={row.label}
                        checked={effectivePicked.includes(row.id)}
                        onCheckedChange={() =>
                          setPicked(toggleAssistantProject(effectivePicked, row.id))
                        }
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{row.label}</span>
                        {row.detail ? (
                          <span
                            dir="rtl"
                            className="truncate text-left text-xs text-muted-foreground"
                          >
                            {row.detail}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {projectChanged ? (
                <Alert variant="warning">
                  <AlertDescription>
                    Changing the project starts a new conversation. The current one moves to
                    Archive, where you can restore it.
                  </AlertDescription>
                </Alert>
              ) : null}
            </fieldset>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleSectionHeader
                expanded={advancedOpen}
                tone="emphasized"
                aria-label="Advanced"
                onClick={() => setAdvancedOpen((open) => !open)}
                accessory={
                  advancedOpen ? null : (
                    <span className="min-w-0 truncate font-normal text-muted-foreground">
                      {advancedSummary}
                    </span>
                  )
                }
              >
                Advanced
              </CollapsibleSectionHeader>
              <CollapsiblePanel animate={false}>
                <div className="flex flex-col gap-5 pt-3">
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel
                      htmlFor="assistant-handle"
                      label="Handle"
                      description="How channels and agents address it. Lowercase letters, numbers and dashes."
                    />
                    <Input
                      id="assistant-handle"
                      value={handle}
                      aria-invalid={
                        !handleValid && (handleInput !== null || name.trim().length > 0)
                      }
                      onChange={(event) => setHandleInput(event.target.value.toLowerCase())}
                    />
                    {!handleValid && (handleInput !== null || name.trim().length > 0) ? (
                      <p className="text-xs text-destructive-foreground">
                        Use 1 to 32 lowercase letters, numbers or dashes, starting and ending with a
                        letter or number.
                      </p>
                    ) : null}
                  </div>
                  {model !== null &&
                  traits !== null &&
                  getTraitsSectionVisibility(traits).hasAnyControls ? (
                    <div className="flex flex-col gap-1.5">
                      <FieldLabel
                        htmlFor="assistant-effort"
                        label="Effort"
                        description="How much it reasons on each turn, plus the other options this model has."
                      />
                      <div id="assistant-effort">
                        <TraitsPicker
                          {...traits}
                          triggerClassName={cn(
                            SETTINGS_PICKER_TRIGGER_CLASSNAME,
                            "min-h-9 w-full justify-start text-left sm:min-h-8 sm:max-w-none",
                          )}
                          onModelOptionsChange={(modelOptions) =>
                            setPickedModel(
                              createModelSelection(model.instanceId, model.model, modelOptions),
                            )
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="text-sm font-medium">Tool access</legend>
                    <p className="text-xs text-muted-foreground">
                      What it may do without asking. Enforced by the conversation's permissions.
                    </p>
                    <RadioGroup
                      aria-label="Tool access"
                      value={toolAccess}
                      onValueChange={(value) => setToolAccess(value as AssistantToolAccess)}
                    >
                      {TOOL_ACCESS_OPTIONS.map((option) => (
                        <label
                          key={option.value}
                          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 outline-hidden hover:bg-foreground/8"
                        >
                          <Radio value={option.value} className="mt-0.5" />
                          <option.icon
                            aria-hidden
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-sm">{option.label}</span>
                            <span className="text-xs font-normal text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </fieldset>
                  <AssistantWorkspaceField
                    environmentId={environmentId}
                    value={workspace}
                    onChange={setWorkspace}
                  />
                  <AskBeforeActingField checked={askBeforeActing} onChange={setAskBeforeActing} />
                  <AssistantConnectorsField value={connectors} onChange={setConnectors} />
                  <BudgetFields
                    draft={budgetDraft}
                    onChange={(patch) => setBudgetDraft((current) => ({ ...current, ...patch }))}
                    spent={spend ? spendLine(spend) : null}
                  />
                  <AssistantNotifications
                    value={autonomy}
                    onChange={setAutonomy}
                    globalAutonomy={settings.autonomy}
                    projects={projectOptions}
                    defaultProjectId={effectiveProjectId}
                  />
                  {assistant?.threadId && environmentId !== null ? (
                    <AssistantSchedules
                      environmentId={environmentId}
                      threadId={assistant.threadId}
                      onNavigate={props.onClose}
                    />
                  ) : null}
                  {assistant && environmentId !== null ? (
                    <AssistantWatches
                      environmentId={environmentId}
                      assistantId={assistant.id}
                      notifies={autonomy.mode === "reply-and-notify"}
                      projects={projectOptions}
                    />
                  ) : null}
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">Memory</span>
                    <p className="text-xs text-muted-foreground">
                      {allPicked
                        ? "Shared with All projects. Give the assistant its own project to keep its memory apart."
                        : effectiveProject
                          ? `Shared with ${projectName(effectiveProject)}${effectivePicked.length > 1 ? ` as its home project. It works in ${pickedLabel}` : ""}. Give the assistant its own project to keep its memory apart.`
                          : "Memory follows the assistant's project."}
                    </p>
                    <Link
                      to="/settings/memory"
                      search={validateMemorySettingsSearch({
                        environmentId: environmentId ?? undefined,
                      })}
                      onClick={props.onClose}
                      className="mt-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-xs text-foreground/75 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <BrainIcon aria-hidden className="size-3.5" />
                      Open Memory settings
                    </Link>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {assistant ? "Save" : "Create assistant"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
