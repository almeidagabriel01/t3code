import { useNavigation } from "@react-navigation/native";
import {
  AuthSettingsWriteScope,
  type Assistant,
  type AssistantId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";
import { RowPressable } from "../../../components/ui/RowPressable";
import { buildModelOptions } from "../../../lib/modelOptions";
import { useAssistantEntries } from "../../../state/assistants";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { useEnvironmentsWithScope } from "../../../state/session";
import { AssistantAvatar } from "../../assistants/assistantPresentation";
import {
  planMobileProjectAssistantModel,
  type ScopedMobileSettingsTarget,
} from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import { modelDisplayName } from "./SettingsModelPicker";
import { SettingsSection } from "./SettingsSection";

type Member = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

const sameModel = (left: ModelSelection | null, right: ModelSelection | null) =>
  left?.instanceId === right?.instanceId && left?.model === right?.model;

/** A model's display name as its environment lists it for the project. */
function useModelName(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const config = useEnvironmentServerConfig(environmentId);
  return (selection: ModelSelection) =>
    modelDisplayName(buildModelOptions(config, selection, undefined, projectId), selection);
}

const SOURCE_TEXT = {
  project: "Set for this project.",
  folder: "From a folder rule.",
  environment: "Follows the environment's default model.",
  "t3.json": "From the repository's t3.json.",
} as const;

function ProjectModelRow(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly reference: ScopedMobileSettingsTarget;
  readonly members: readonly Member[];
  readonly disabled: boolean;
}) {
  const navigation = useNavigation();
  const { reference } = props;
  const nameOf = useModelName(reference.environment.environmentId, reference.projectId);
  const selection = reference.settings.defaultModelSelection;
  const mixed = props.targets.some(
    (target) => !sameModel(target.settings.defaultModelSelection, selection),
  );
  const label = mixed ? "Mixed" : selection === null ? "Automatic" : nameOf(selection);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`Model, ${label}`}
      disabled={props.disabled}
      onPress={() => navigation.navigate("SettingsProjectModel", { members: props.members })}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon="cube"
        label={label}
        description={
          mixed
            ? "The checkouts differ. Pick one model for all of them."
            : selection === null
              ? "Selected automatically."
              : SOURCE_TEXT[reference.sources.defaultModelSelection]
        }
        disabled={props.disabled}
        accessory={
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        }
      />
    </RowPressable>
  );
}

function AssistantModelRow(props: {
  readonly target: ScopedMobileSettingsTarget;
  readonly assistant: Assistant | undefined;
  readonly selection: ModelSelection;
  readonly environmentLabel: string | null;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const { target } = props;
  const nameOf = useModelName(target.environment.environmentId, target.projectId);
  const name = props.assistant?.name ?? "Removed assistant";
  const model = nameOf(props.selection);
  return (
    <View
      className={
        props.separated
          ? "flex-row items-center border-t border-border-subtle bg-grouped-card"
          : "flex-row items-center bg-grouped-card"
      }
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`Model for ${name}, ${model}`}
        disabled={props.disabled}
        onPress={props.onOpen}
        className="min-w-0 flex-1"
      >
        <ListRowLayout
          leading={
            props.assistant ? (
              <AssistantAvatar
                assistant={props.assistant}
                environmentId={target.environment.environmentId}
                size={28}
              />
            ) : (
              <SymbolView
                name="person.crop.circle"
                size={22}
                tintColorClassName="accent-icon-subtle"
                type="monochrome"
              />
            )
          }
          label={name}
          description={props.environmentLabel ? `${model} · ${props.environmentLabel}` : model}
          disabled={props.disabled}
        />
      </RowPressable>
      <Menu
        actions={[
          {
            id: "remove",
            title: "Remove",
            image: "trash",
            attributes: { destructive: true, disabled: props.disabled },
          },
        ]}
        onPressAction={props.onRemove}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${name} actions`}
          disabled={props.disabled}
          hitSlop={6}
          className="me-2 size-11 items-center justify-center rounded-full active:opacity-70"
        >
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}

/**
 * The project's model for new threads, and the assistants that start its threads on their own
 * model. Rows open the model picker; an assistant's model saves only on its environment.
 */
export function ProjectModelSections(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  /** The page cannot write right now (no permission, a managed policy, or a save in flight). */
  readonly disabled: boolean;
  /** Assistant models belong to one project; several selected projects hide them. */
  readonly showAssistants: boolean;
  readonly onReset: () => void;
}) {
  const { targets } = props;
  const navigation = useNavigation();
  const writeSettings = useSettingsWriter();
  const { active, archived } = useAssistantEntries();
  const writable = useEnvironmentsWithScope(
    targets.map((target) => target.environment),
    AuthSettingsWriteScope,
  );
  const reference = targets[0];
  if (reference === undefined) return null;
  const members = targets.flatMap((target) =>
    target.projectId === null
      ? []
      : [{ environmentId: target.environment.environmentId, projectId: target.projectId }],
  );
  const severalEnvironments =
    new Set(targets.map((target) => target.environment.environmentId)).size > 1;
  const assistantSelections = (target: ScopedMobileSettingsTarget) =>
    target.projectId === null
      ? undefined
      : target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId]
          ?.assistantModelSelections;
  const rows = targets.flatMap((target) =>
    Object.entries(assistantSelections(target) ?? {}).map(([id, selection]) => {
      const environmentId = target.environment.environmentId;
      const assistant = [...active, ...archived].find(
        (entry) => entry.environmentId === environmentId && entry.assistant.id === id,
      )?.assistant;
      return {
        key: `${environmentId}:${target.projectId}:${id}`,
        target,
        environmentId,
        assistantId: id as AssistantId,
        assistant,
        name: assistant?.name ?? "Removed assistant",
        selection,
      };
    }),
  );
  rows.sort((left, right) => left.name.localeCompare(right.name));
  const available = active.filter(
    (entry) =>
      writable.has(entry.environmentId) &&
      targets.some(
        (target) =>
          target.environment.environmentId === entry.environmentId &&
          assistantSelections(target)?.[entry.assistant.id] === undefined,
      ),
  );
  const openAssistantPicker = (environmentId: EnvironmentId, assistantId: AssistantId) =>
    navigation.navigate("SettingsProjectModel", {
      members: members.filter((member) => member.environmentId === environmentId),
      assistantId,
    });
  const environmentLabel = (environmentId: EnvironmentId) =>
    targets.find((target) => target.environment.environmentId === environmentId)?.environment
      .label ?? "";
  const cannotAdd = props.disabled || available.length === 0;
  const addRow = (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel="Add assistant"
      disabled={cannotAdd}
      className={
        rows.length > 0 ? "border-t border-border-subtle bg-grouped-card" : "bg-grouped-card"
      }
    >
      <ListRowLayout icon="plus" label="Add assistant" disabled={cannotAdd} />
    </RowPressable>
  );

  return (
    <>
      <SettingsSection title="Model" footer="Model for new threads in this project.">
        <ProjectModelRow
          targets={targets}
          reference={reference}
          members={members}
          disabled={props.disabled}
        />
        {targets.some((target) => target.sources.defaultModelSelection === "project") ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon="arrow.uturn.backward"
              label="Use the environment's model"
              disabled={props.disabled}
              onPress={props.onReset}
            />
          </View>
        ) : null}
      </SettingsSection>
      {props.showAssistants ? (
        <SettingsSection
          title="Model by assistant"
          footer="These assistants start new threads in this project on their own model."
        >
          {rows.map((row, index) => (
            <AssistantModelRow
              key={row.key}
              target={row.target}
              assistant={row.assistant}
              selection={row.selection}
              environmentLabel={severalEnvironments ? row.target.environment.label : null}
              separated={index > 0}
              disabled={props.disabled || !writable.has(row.environmentId)}
              onOpen={() => openAssistantPicker(row.environmentId, row.assistantId)}
              onRemove={() =>
                void writeSettings(
                  targets,
                  planMobileProjectAssistantModel(
                    targets,
                    row.environmentId,
                    row.assistantId,
                    null,
                  ),
                )
              }
            />
          ))}
          {cannotAdd ? (
            addRow
          ) : (
            <Menu
              actions={available.map((entry) => ({
                id: JSON.stringify([entry.environmentId, entry.assistant.id]),
                title: entry.assistant.name,
                ...(severalEnvironments ? { subtitle: environmentLabel(entry.environmentId) } : {}),
              }))}
              onPressAction={({ nativeEvent }) => {
                const [environmentId, assistantId] = JSON.parse(nativeEvent.event) as [
                  EnvironmentId,
                  AssistantId,
                ];
                openAssistantPicker(environmentId, assistantId);
              }}
            >
              {addRow}
            </Menu>
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}
