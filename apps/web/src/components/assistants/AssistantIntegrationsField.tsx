import {
  assistantIntegrationPicker,
  integrationProviderSupport,
  notAvailableOnLabel,
  sandboxWorkNote,
  selectionForMode,
  toggleIntegration,
} from "@t3tools/client-runtime/integrations";
import type {
  AssistantIntegrations,
  AssistantWorkspace,
  EnvironmentId,
  IntegrationsState,
} from "@t3tools/contracts";

import { useIntegrationsState } from "../../state/integrations";
import { TONE_BADGE } from "../integrations/IntegrationRow";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";

const OPTION_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8";

export const sameIntegrations = (left: AssistantIntegrations, right: AssistantIntegrations) =>
  left.mode === right.mode &&
  (left.mode === "all" ||
    (right.mode === "selected" &&
      left.names.length === right.names.length &&
      left.names.every((name) => right.names.includes(name))));

/** Which integrations the assistant gets: all connected ones, or a checklist. */
export function AssistantIntegrationsField(props: {
  readonly state: IntegrationsState;
  readonly value: AssistantIntegrations;
  readonly onChange: (next: AssistantIntegrations) => void;
  /** Where the assistant's work runs, as chosen in the form. */
  readonly workspace: AssistantWorkspace;
  /** The assistant's provider instance, when it has a model. */
  readonly provider: {
    readonly instanceId: string;
    readonly driverKind: string;
    readonly displayName: string;
  } | null;
}) {
  const { provider } = props;
  const picker = assistantIntegrationPicker({
    state: props.state,
    selection: props.value,
    driverKind: provider?.driverKind ?? "",
    instanceId: provider?.instanceId ?? "",
  });
  const sandboxNote = sandboxWorkNote(props.workspace);
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">Integrations</legend>
      {sandboxNote === null ? null : <p className="text-xs text-muted-foreground">{sandboxNote}</p>}
      {provider !== null && !integrationProviderSupport(provider.driverKind) ? (
        <p className="text-xs text-warning-foreground">
          {notAvailableOnLabel(provider.displayName)}
        </p>
      ) : null}
      <RadioGroup
        aria-label="Integrations"
        value={props.value.mode}
        onValueChange={(mode) =>
          props.onChange(
            selectionForMode(mode === "selected" ? "selected" : "all", props.value, props.state),
          )
        }
      >
        <label className={OPTION_CLASS}>
          <Radio value="all" />
          All connected
        </label>
        <label className={OPTION_CLASS}>
          <Radio value="selected" />
          Choose…
        </label>
      </RadioGroup>
      {props.value.mode === "selected" ? (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto ps-6">
          {picker.items.map((item) => (
            <li key={item.key}>
              <label
                className={
                  item.disabled
                    ? "flex items-start gap-2 rounded-md px-1.5 py-1 text-sm opacity-64"
                    : "flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/8"
                }
              >
                <Checkbox
                  aria-label={item.title}
                  className="mt-0.5"
                  checked={item.selected}
                  disabled={item.disabled}
                  onCheckedChange={() => props.onChange(toggleIntegration(props.value, item.name))}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{item.title}</span>
                    {item.status === null ? null : (
                      <Badge variant={TONE_BADGE[item.status.tone]} size="sm">
                        {item.status.label}
                      </Badge>
                    )}
                  </span>
                  {item.note === null ? null : (
                    <span className="text-xs text-muted-foreground">{item.note}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

/** The integrations an assistant gets, each with its status; attention ones stand out. */
export function AssistantIntegrationChips(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: AssistantIntegrations;
}) {
  const state = useIntegrationsState(props.environmentId);
  if (state === null) return null;
  const items = assistantIntegrationPicker({
    state,
    selection: props.selection,
    driverKind: "",
    instanceId: "",
  }).items.filter((item) => item.selected && item.status !== null);
  if (items.length === 0) return null;
  return (
    <ul aria-label="Integrations" className="flex flex-wrap gap-1">
      {items.map((item) => (
        <li key={item.key} className="list-none">
          <Badge
            variant={
              item.status?.tone === "warning" || item.status?.tone === "danger"
                ? "warning"
                : "outline"
            }
            size="sm"
          >
            {item.title} · {item.status?.label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
