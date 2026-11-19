import type {
  AssistantEnvironmentPreference,
  AssistantScope,
  AssistantWorkspace,
  EnvironmentId,
  PeerLinkStatus,
} from "@t3tools/contracts";

export const ASSISTANT_DEFAULT_ENVIRONMENT_LABEL = "Default environment";
export const ASSISTANT_DEFAULT_ENVIRONMENT_DESCRIPTION =
  "Where work it launches runs. Running work stays where it is.";

export interface AssistantEnvironmentLink {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: PeerLinkStatus;
}

/** A group's picker adds "members": no default of its own, so each member's applies. */
export type AssistantEnvironmentPick = AssistantEnvironmentPreference | "members";

export interface AssistantEnvironmentOption {
  readonly value: AssistantEnvironmentPick;
  readonly label: string;
  readonly detail: string | null;
}

export interface AssistantEnvironmentChoice {
  readonly selected: AssistantEnvironmentPick;
  /** The trigger's text; differs from the selected option's label only while it is disabled. */
  readonly display: string;
  readonly options: ReadonlyArray<AssistantEnvironmentOption>;
  /** Set when the choice cannot change here, saying why. */
  readonly disabledReason: string | null;
}

const LOCAL: AssistantEnvironmentOption = {
  value: "local",
  label: "Local",
  detail: "The server this chat runs on",
};
const MEMBERS: AssistantEnvironmentOption = {
  value: "members",
  label: "Members' defaults",
  detail: "Each member's own default environment",
};
const AUTO: AssistantEnvironmentOption = {
  value: "auto",
  label: "Auto",
  detail: "The least loaded machine",
};

const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/**
 * The default-environment picker: Local, each link the assistant's server has, and Auto.
 * `links` is null while they are not known, so a stored link is not called unavailable yet.
 */
export function assistantEnvironmentChoice(input: {
  readonly value: AssistantEnvironmentPreference | null | undefined;
  readonly serverEnvironmentId: EnvironmentId;
  readonly linksOffered: boolean;
  readonly links: ReadonlyArray<AssistantEnvironmentLink> | null;
  /** Assistants only; a group has neither. */
  readonly workspace?: AssistantWorkspace;
  readonly scope?: AssistantScope;
  readonly group?: boolean;
}): AssistantEnvironmentChoice {
  const group = input.group === true;
  const stored: AssistantEnvironmentPick =
    input.value == null
      ? group
        ? "members"
        : "local"
      : input.value === input.serverEnvironmentId
        ? "local"
        : input.value;
  const base = group ? [MEMBERS, LOCAL] : [LOCAL];
  if (input.workspace === "sandbox") {
    return {
      selected: "local",
      display: "Sandbox container",
      options: [LOCAL],
      disabledReason: "It works in its sandbox container, so its work launches there.",
    };
  }
  if (input.scope === "project") {
    return {
      selected: "local",
      display: LOCAL.label,
      options: [LOCAL],
      disabledReason: "Assistants limited to projects launch work on this server.",
    };
  }
  if (!input.linksOffered) {
    const selected = stored === "members" ? "members" : "local";
    return {
      selected,
      display: (selected === "members" ? MEMBERS : LOCAL).label,
      options: base,
      disabledReason: "Turn on Linked environments in Settings to pick another machine.",
    };
  }
  const links = input.links ?? [];
  const linkOptions = links
    .filter((link) => link.status !== "expired")
    .map((link): AssistantEnvironmentOption => ({
      value: link.environmentId,
      label: link.label,
      detail: link.status === "unreachable" ? "Not answering now" : null,
    }));
  const options = [...base, ...linkOptions, AUTO];
  let current = options.find((option) => option.value === stored);
  if (current === undefined) {
    const expired = links.find((link) => link.environmentId === stored);
    current = {
      value: stored,
      label:
        expired !== undefined
          ? `${expired.label} (expired)`
          : input.links === null
            ? shortId(stored)
            : `Unavailable (${shortId(stored)})`,
      detail: null,
    };
    options.splice(options.length - 1, 0, current);
  }
  return { selected: stored, display: current.label, options, disabledReason: null };
}

/**
 * What picking `value` writes. An assistant's Local clears it, since unset already means Local;
 * a group's Local is kept, since unset there means its members' own defaults.
 */
export const assistantEnvironmentInput = (
  value: AssistantEnvironmentPick,
  group = false,
): AssistantEnvironmentPreference | null =>
  value === "members" || (value === "local" && !group) ? null : value;
