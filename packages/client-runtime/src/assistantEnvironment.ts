import type {
  Assistant,
  AssistantsUpdateInput,
  AssistantTeam,
  AssistantTeamsUpdateInput,
  EnvironmentId,
} from "@t3tools/contracts";

// Provisional until the contract lands: replace with `AssistantEnvironmentPreference` from
// `@t3tools/contracts`, then drop the casts in `defaultEnvironmentOf` and the two update builders.
export type AssistantEnvironmentPreference = "local" | "auto" | EnvironmentId;
/** Null inherits: Local for an assistant, each member's own default for a group. */
export type AssistantEnvironmentValue = AssistantEnvironmentPreference | null;

/** Every user-visible string of the "where work runs" picker; names still await sign-off. */
export const ASSISTANT_ENVIRONMENT_COPY = {
  rowLabel: "Runs on",
  pickerTitle: "Runs on",
  pickerFooter: "Where the threads and tasks it starts run. Work already running stays put.",
  local: "Local",
  localDescription: "This assistant's own machine",
  groupLocalDescription: "The group's own machine",
  auto: "Auto",
  autoDescription: "The least busy machine when work starts",
  assistantInherit: "Local (default)",
  groupInherit: "Each member's default",
  groupInheritDescription: "Every member uses its own setting",
  linkedMachine: "Linked machine",
  unavailable: "Unavailable machine",
  unavailableDescription: "Unlinked or expired. Work fails until you pick another.",
  linksOff:
    "Linked environments are off on this machine, so work runs here. Turn them on in Settings to pick another machine.",
  sandboxDisabled: "A sandboxed assistant always works in its sandbox.",
  sandboxCurrent: "Sandbox",
  projectDisabled: "A project assistant always works on its own machine.",
  saveFailed: "Could not change where work runs",
} as const;

type Subject = Pick<Assistant, "id"> | Pick<AssistantTeam, "id">;

/** The stored preference; undefined when the server does not send it. */
export const defaultEnvironmentOf = (
  subject: Assistant | AssistantTeam,
): AssistantEnvironmentValue | undefined =>
  (subject as Subject & { readonly defaultEnvironment?: AssistantEnvironmentValue })
    .defaultEnvironment;

/**
 * Whether the server stores a preference for this subject. Always true while the contract is in
 * flight; after the merge it becomes `defaultEnvironmentOf(subject) !== undefined`, hiding the row
 * for older servers like the group's default model.
 */
export const supportsDefaultEnvironment = (_subject: Assistant | AssistantTeam): boolean => true;

export const assistantEnvironmentUpdate = (
  assistantId: Assistant["id"],
  defaultEnvironment: AssistantEnvironmentValue,
): AssistantsUpdateInput => ({ assistantId, defaultEnvironment }) as AssistantsUpdateInput;

/** The group's field, spread into its settings save. */
export const assistantTeamEnvironmentFields = (
  defaultEnvironment: AssistantEnvironmentValue,
): Partial<AssistantTeamsUpdateInput> =>
  ({ defaultEnvironment }) as unknown as Partial<AssistantTeamsUpdateInput>;

export interface AssistantEnvironmentOption {
  readonly key: string;
  readonly value: AssistantEnvironmentValue;
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
}

export interface AssistantEnvironmentPicker {
  /** What the row shows now: where work actually runs. */
  readonly current: string;
  /** Set when the row cannot open; shown under it. */
  readonly disabledReason: string | null;
  /** Shown under the choices, such as links being off. */
  readonly notice: string | null;
  readonly options: ReadonlyArray<AssistantEnvironmentOption>;
}

export interface AssistantEnvironmentPickerInput {
  readonly subject: "assistant" | "group";
  readonly value: AssistantEnvironmentValue;
  /** The links of the assistant's own server, by name; null until they load. */
  readonly links: ReadonlyMap<EnvironmentId, string> | null;
  readonly linksEnabled: boolean;
  /** Assistant only. */
  readonly workspace?: Assistant["workspace"];
  readonly scope?: Assistant["scope"];
}

const C = ASSISTANT_ENVIRONMENT_COPY;

/**
 * The picker's choices and the row's label. An assistant's null and "local" both run locally, so
 * they share one checked Local row; a group's null is its own row. A stored id the links no longer
 * list stays checked as unavailable instead of quietly reading as Local.
 */
export function assistantEnvironmentPicker(
  input: AssistantEnvironmentPickerInput,
): AssistantEnvironmentPicker {
  const { value, links, linksEnabled } = input;
  const group = input.subject === "group";
  const disabledReason =
    input.workspace === "sandbox"
      ? C.sandboxDisabled
      : input.scope === "project"
        ? C.projectDisabled
        : null;
  const remote = value !== null && value !== "local";
  const linkName = (id: EnvironmentId) =>
    links === null ? C.linkedMachine : (links.get(id) ?? C.unavailable);

  const current =
    input.workspace === "sandbox"
      ? C.sandboxCurrent
      : disabledReason !== null || value === "local" || (remote && !linksEnabled)
        ? C.local
        : value === null
          ? group
            ? C.groupInherit
            : C.assistantInherit
          : value === "auto"
            ? C.auto
            : linkName(value);

  const option = (
    key: string,
    optionValue: AssistantEnvironmentValue,
    label: string,
    selected: boolean,
    description?: string,
  ): AssistantEnvironmentOption => ({
    key,
    value: optionValue,
    label,
    selected,
    ...(description === undefined ? {} : { description }),
  });
  const options: AssistantEnvironmentOption[] = [
    ...(group
      ? [option("inherit", null, C.groupInherit, value === null, C.groupInheritDescription)]
      : []),
    option(
      "local",
      "local",
      C.local,
      value === "local" || (!group && value === null),
      group ? C.groupLocalDescription : C.localDescription,
    ),
  ];
  if (linksEnabled) {
    const named = [...(links ?? new Map<EnvironmentId, string>())].sort(([, a], [, b]) =>
      a.localeCompare(b),
    );
    for (const [id, name] of named) options.push(option(id, id, name, value === id));
    if (remote && value !== "auto" && links !== null && !links.has(value)) {
      options.push(option(value, value, C.unavailable, true, C.unavailableDescription));
    }
    options.push(option("auto", "auto", C.auto, value === "auto", C.autoDescription));
  }
  return {
    current,
    disabledReason,
    notice: linksEnabled || disabledReason !== null ? null : C.linksOff,
    options,
  };
}
