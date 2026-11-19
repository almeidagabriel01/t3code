import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  ASSISTANT_ENVIRONMENT_COPY as COPY,
  assistantEnvironmentPicker,
  assistantEnvironmentUpdate,
  defaultEnvironmentOf,
  type AssistantEnvironmentPicker,
  type AssistantEnvironmentPickerInput,
  type AssistantEnvironmentValue,
} from "@t3tools/client-runtime/assistantEnvironment";
import {
  linkedEnvironmentNames,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useAssistantActions, useAssistantEntries } from "../../state/assistants";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { assistantTeamTargetAtom, setGroupDefaultEnvironmentDraft } from "./assistantTeamTarget";

type PickerSubject = Pick<AssistantEnvironmentPickerInput, "subject" | "workspace" | "scope">;

/**
 * The picker for `value` on the assistant's own server: its links, never this client's. Listing
 * links asks each one whether it answers, so a row reads them only when it must name one.
 */
export function useAssistantEnvironmentPicker(
  environmentId: EnvironmentId | null,
  subject: PickerSubject,
  value: AssistantEnvironmentValue,
  needsLinks: boolean,
): AssistantEnvironmentPicker {
  const linksEnabled = offersLinkedEnvironments(useEnvironmentServerConfig(environmentId));
  const { environments } = useEnvironments();
  const links = useEnvironmentQuery(
    linksEnabled && needsLinks && environmentId !== null
      ? peerLinkEnvironment.list({ environmentId, input: {} })
      : null,
  );
  const names = useMemo(
    () => (links.data ? linkedEnvironmentNames({ links: links.data.links, environments }) : null),
    [environments, links.data],
  );
  return assistantEnvironmentPicker({ ...subject, value, links: names, linksEnabled });
}

/** True when the row must name a link: the stored value is one. */
export const namesLink = (value: AssistantEnvironmentValue) =>
  value !== null && value !== "local" && value !== "auto";

/** The "Runs on" row; a disabled one says why instead of opening. */
export function AssistantEnvironmentRow(props: {
  readonly picker: AssistantEnvironmentPicker;
  readonly icon?: AppSymbolName;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const { picker } = props;
  return (
    <ListRow
      {...(props.icon ? { icon: props.icon } : {})}
      label={COPY.rowLabel}
      detail={picker.current}
      {...(picker.disabledReason === null ? {} : { description: picker.disabledReason })}
      disabled={picker.disabledReason !== null || props.disabled === true}
      onPress={props.onPress}
    />
  );
}

/** One checked choice per row; the notice or the footer explains what the choice does. */
function EnvironmentChoices(props: {
  readonly picker: AssistantEnvironmentPicker;
  readonly busy: boolean;
  readonly onPick: (value: AssistantEnvironmentValue) => void;
}) {
  const { options, notice } = props.picker;
  return (
    <SettingsScreen title={COPY.pickerTitle}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-2 px-5 pt-4 pb-10"
      >
        <View>
          {options.map((option, index) => (
            <SelectionRow
              key={option.key}
              title={option.label}
              {...(option.description === undefined ? {} : { subtitle: option.description })}
              selected={option.selected}
              disabled={props.busy}
              isFirst={index === 0}
              isLast={index === options.length - 1}
              onPress={() => props.onPick(option.value)}
            />
          ))}
        </View>
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {notice ?? COPY.pickerFooter}
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}

const selectedValue = (picker: AssistantEnvironmentPicker) =>
  picker.options.find((option) => option.selected)?.value;

/** Saves the assistant's choice at once, like its other Info toggles. */
export function AssistantEnvironmentPickerRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly assistantId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const assistantId = AssistantId.make(route.params.assistantId);
  const navigation = useNavigation();
  const actions = useAssistantActions(environmentId);
  const { active, archived } = useAssistantEntries();
  const assistant = [...active, ...archived].find(
    (entry) => entry.environmentId === environmentId && entry.assistant.id === assistantId,
  )?.assistant;
  const value = assistant ? (defaultEnvironmentOf(assistant) ?? null) : null;
  const picker = useAssistantEnvironmentPicker(
    environmentId,
    assistant
      ? { subject: "assistant", workspace: assistant.workspace, scope: assistant.scope }
      : { subject: "assistant" },
    value,
    true,
  );
  const [busy, setBusy] = useState(false);
  if (!assistant) {
    return (
      <SettingsScreen title={COPY.pickerTitle}>
        <Text className="p-5 text-base text-foreground-muted">Open an assistant first.</Text>
      </SettingsScreen>
    );
  }
  const pick = async (next: AssistantEnvironmentValue) => {
    if (next === selectedValue(picker)) return navigation.goBack();
    setBusy(true);
    const reply = await actions.update(assistantEnvironmentUpdate(assistant.id, next));
    setBusy(false);
    if (reply.ok) navigation.goBack();
    else Dialog.alert(COPY.saveFailed, reply.message);
  };
  return (
    <EnvironmentChoices
      picker={picker}
      busy={busy || !actions.canAct}
      onPick={(next) => void pick(next)}
    />
  );
}

/** Picks the group's choice into its open settings form; Save sends it with the rest. */
export function GroupEnvironmentPickerRouteScreen() {
  const navigation = useNavigation();
  const target = useAtomValue(assistantTeamTargetAtom);
  const { teams } = useAssistantEntries();
  const team =
    target?.teamId == null
      ? undefined
      : teams.find(
          (entry) =>
            entry.environmentId === target.environmentId && entry.team.id === target.teamId,
        )?.team;
  const value =
    target?.defaultEnvironmentDraft === undefined
      ? team
        ? (defaultEnvironmentOf(team) ?? null)
        : null
      : target.defaultEnvironmentDraft;
  const picker = useAssistantEnvironmentPicker(
    target?.environmentId ?? null,
    { subject: "group" },
    value,
    team !== undefined,
  );
  if (target === null || team === undefined) {
    return (
      <SettingsScreen title={COPY.pickerTitle}>
        <Text className="p-5 text-base text-foreground-muted">Open a group first.</Text>
      </SettingsScreen>
    );
  }
  return (
    <EnvironmentChoices
      picker={picker}
      busy={false}
      onPick={(next) => {
        if (next !== value) setGroupDefaultEnvironmentDraft(next);
        navigation.goBack();
      }}
    />
  );
}
