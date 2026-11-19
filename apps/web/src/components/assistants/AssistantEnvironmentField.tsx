import { useAtomValue } from "@effect/atom-react";
import {
  ASSISTANT_DEFAULT_ENVIRONMENT_DESCRIPTION,
  ASSISTANT_DEFAULT_ENVIRONMENT_LABEL,
  assistantEnvironmentChoice,
  assistantEnvironmentInput,
  type AssistantEnvironmentPick,
} from "@t3tools/client-runtime/assistantEnvironment";
import type {
  AssistantEnvironmentPreference,
  AssistantScope,
  AssistantWorkspace,
  EnvironmentId,
} from "@t3tools/contracts";
import { useId } from "react";

import { useEnvironmentIdentities } from "../../state/environments";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/**
 * Where an assistant's or group's launches run by default: Local, a machine its server links
 * to, or Auto. Writes nothing itself; the panel saves on pick and the dialogs on Save.
 */
export function AssistantEnvironmentField(props: {
  readonly environmentId: EnvironmentId;
  readonly value: AssistantEnvironmentPreference | null | undefined;
  readonly workspace?: AssistantWorkspace;
  readonly scope?: AssistantScope;
  /** A group's picker, where unset means each member's own default. */
  readonly group?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: AssistantEnvironmentPreference | null) => void;
}) {
  const id = useId();
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(props.environmentId));
  const identities = useEnvironmentIdentities();
  const query = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const choice = assistantEnvironmentChoice({
    value: props.value,
    serverEnvironmentId: props.environmentId,
    linksOffered: offered,
    links:
      query.data?.links.map((link) => ({
        environmentId: link.environmentId,
        status: link.status,
        label:
          identities.find((entry) => entry.environmentId === link.environmentId)?.label ??
          link.label,
      })) ?? null,
    ...(props.workspace === undefined ? {} : { workspace: props.workspace }),
    ...(props.scope === undefined ? {} : { scope: props.scope }),
    ...(props.group === true ? { group: true } : {}),
  });
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{ASSISTANT_DEFAULT_ENVIRONMENT_LABEL}</Label>
        <p className="text-xs text-muted-foreground">{ASSISTANT_DEFAULT_ENVIRONMENT_DESCRIPTION}</p>
      </div>
      <Select<AssistantEnvironmentPick>
        value={choice.selected}
        disabled={props.disabled === true || choice.disabledReason !== null}
        onValueChange={(next) => {
          if (next !== null && next !== choice.selected) {
            props.onChange(assistantEnvironmentInput(next, props.group === true));
          }
        }}
      >
        <SelectTrigger id={id} aria-label={ASSISTANT_DEFAULT_ENVIRONMENT_LABEL}>
          <SelectValue>{choice.display}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {choice.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.detail === null ? null : (
                  <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {choice.disabledReason === null ? null : (
        <p className="text-xs text-muted-foreground">{choice.disabledReason}</p>
      )}
    </div>
  );
}
