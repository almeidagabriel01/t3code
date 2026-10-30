import { useAtomValue } from "@effect/atom-react";
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_LENGTH,
  assistantHandleFromName,
  AssistantHandle,
  type AssistantToolAccess,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { BrainIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import {
  useAssistantActions,
  useAssistantEntries,
  useAssistantsEnvironmentIds,
} from "../../state/assistants";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { validateMemorySettingsSearch } from "../settings/MemorySettings.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { assistantDialogAtom, type AssistantDialogTarget } from "./assistantDialogState";
import { TOOL_ACCESS_OPTIONS } from "./assistantPresentation";
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

  const [name, setName] = useState(assistant?.name ?? "");
  const [handleInput, setHandleInput] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(assistant?.instructions ?? "");
  const [toolAccess, setToolAccess] = useState<AssistantToolAccess>(
    assistant?.toolAccess ?? "full",
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(assistant?.projectId ?? null);
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const groups = useSidebarProjectGroups();
  const projectName = (candidate: (typeof projects)[number]) =>
    groups.find((group) =>
      group.memberProjects.some(
        (member) => member.environmentId === candidate.environmentId && member.id === candidate.id,
      ),
    )?.displayName ?? candidate.title;
  const effectiveProjectId =
    projectId ?? projects.find((project) => project.isScratch)?.id ?? projects[0]?.id ?? null;
  const effectiveProject = projects.find((project) => project.id === effectiveProjectId) ?? null;

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

  const derivedHandle = assistantHandleFromName(name) ?? "";
  const handle = handleInput ?? (assistant ? assistant.handle : derivedHandle);
  const handleValid = isValidHandle(handle);
  const projectChanged =
    assistant !== null && effectiveProjectId !== null && effectiveProjectId !== assistant.projectId;
  const canSave =
    !saving &&
    environmentId !== null &&
    actions.canAct &&
    name.trim().length > 0 &&
    handleValid &&
    effectiveProjectId !== null;

  const save = async () => {
    if (!canSave || effectiveProjectId === null) return;
    setSaving(true);
    setError(null);
    const trimmedName = name.trim();
    const reply = assistant
      ? await actions.update({
          assistantId: assistant.id,
          ...(trimmedName !== assistant.name ? { name: trimmedName } : {}),
          ...(handle !== assistant.handle ? { handle } : {}),
          ...(projectChanged ? { projectId: effectiveProjectId } : {}),
          ...(pickedModel ? { modelSelection: pickedModel } : {}),
          ...(instructions !== assistant.instructions ? { instructions } : {}),
          ...(toolAccess !== assistant.toolAccess ? { toolAccess } : {}),
        })
      : await actions.create({
          name: trimmedName,
          handle,
          projectId: effectiveProjectId,
          ...(pickedModel ? { modelSelection: pickedModel } : {}),
          instructions,
          toolAccess,
        });
    setSaving(false);
    if (reply.ok) props.onClose();
    else setError(reply.message);
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
            className="flex flex-col gap-5"
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
                    setProjectId(null);
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
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-name"
                label="Name"
                description="Shown in the sidebar and at the top of its conversation."
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
                htmlFor="assistant-handle"
                label="Handle"
                description="How channels and agents address it. Lowercase letters, numbers and dashes."
              />
              <Input
                id="assistant-handle"
                value={handle}
                aria-invalid={!handleValid}
                onChange={(event) => setHandleInput(event.target.value.toLowerCase())}
              />
              {!handleValid ? (
                <p className="text-xs text-destructive-foreground">
                  Use 1 to 32 lowercase letters, numbers or dashes, starting and ending with a
                  letter or number.
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-project"
                label="Project"
                description="The folder it works in, and whose memory it shares."
              />
              <Select
                value={effectiveProjectId}
                onValueChange={(next) => setProjectId(next as ProjectId)}
              >
                <SelectTrigger id="assistant-project" aria-label="Project">
                  <SelectValue>
                    {effectiveProject
                      ? effectiveProject.isScratch
                        ? "No project"
                        : projectName(effectiveProject)
                      : "No projects available"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {projects.map((project) => (
                    <SelectItem hideIndicator key={project.id} value={project.id}>
                      {project.isScratch ? "No project" : projectName(project)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {projectChanged ? (
                <Alert variant="warning">
                  <AlertDescription>
                    Changing the project starts a new conversation. The current one moves to
                    Archive, where you can restore it.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-model"
                label="Model"
                description={
                  assistant
                    ? "Applies to its current conversation."
                    : "Starts on your default model unless you choose another."
                }
              />
              <div id="assistant-model" className="flex">
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
                    onInstanceModelChange={(instanceId, next) =>
                      setPickedModel(createModelSelection(instanceId, next))
                    }
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">No providers available</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <FieldLabel
                htmlFor="assistant-instructions"
                label="Instructions"
                description="Standing guidance sent with every turn: its role, tone and rules."
              />
              <Textarea
                id="assistant-instructions"
                rows={6}
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
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Memory</span>
              <p className="text-xs text-muted-foreground">
                {effectiveProject
                  ? `Shared with ${effectiveProject.isScratch ? "No project" : projectName(effectiveProject)}. Give the assistant its own project to keep its memory apart.`
                  : "Memory follows the assistant's project."}
              </p>
              <Link
                to="/settings/memory"
                search={validateMemorySettingsSearch({ environmentId: environmentId ?? undefined })}
                onClick={props.onClose}
                className="mt-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-xs text-foreground/75 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <BrainIcon aria-hidden className="size-3.5" />
                Open Memory settings
              </Link>
            </div>
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
