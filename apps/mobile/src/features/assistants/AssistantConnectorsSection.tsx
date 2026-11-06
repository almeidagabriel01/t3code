import {
  CONNECTOR_TRANSPORT_LABELS,
  CONNECTORS_PROVIDER_NOTE,
  connectorDraftsProblem,
  emptyConnectorDraft,
  newConnectorRow,
  type ConnectorDraft,
  type ConnectorRowDraft,
} from "@t3tools/client-runtime/assistantConnectors";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { ChoiceRow, FieldHeader, TextField } from "./AssistantFormFields";

const INPUT_CLASS = "min-h-8 flex-1 font-sans text-base text-foreground";

function RowsEditor(props: {
  readonly label: string;
  readonly addLabel: string;
  readonly keyLabel: string;
  readonly rows: ReadonlyArray<ConnectorRowDraft>;
  readonly onChange: (rows: ReadonlyArray<ConnectorRowDraft>) => void;
}) {
  const patch = (index: number, next: Partial<ConnectorRowDraft>) =>
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...next } : row)));
  return (
    <View className="gap-2">
      <FieldHeader
        label={props.label}
        description="Values are stored on the server and never shown again. Leave a saved value empty to keep it."
      />
      <ListSection>
        {props.rows.map((row, index) => (
          <View key={row.id} className="flex-row items-center gap-2 bg-grouped-card px-4">
            <TextInput
              accessibilityLabel={`${props.keyLabel} ${index + 1}`}
              placeholder={props.keyLabel}
              value={row.key}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(key) => patch(index, { key })}
              placeholderTextColorClassName="accent-foreground-muted"
              className={INPUT_CLASS}
            />
            <TextInput
              accessibilityLabel={`${props.keyLabel} ${index + 1} value`}
              placeholder={row.saved ? "Saved" : "Value"}
              value={row.value}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) => patch(index, { value })}
              placeholderTextColorClassName="accent-foreground-muted"
              className={INPUT_CLASS}
            />
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${props.keyLabel.toLowerCase()} ${index + 1}`}
              onPress={() => props.onChange(props.rows.filter((_, i) => i !== index))}
              className="px-2 py-2"
            >
              <SymbolView
                name="xmark"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </RowPressable>
          </View>
        ))}
        <ListActionRow
          icon="plus"
          label={props.addLabel}
          onPress={() => props.onChange([...props.rows, newConnectorRow()])}
        />
      </ListSection>
    </View>
  );
}

function ConnectorForm(props: {
  readonly draft: ConnectorDraft;
  readonly isNew: boolean;
  readonly problem: string | null;
  readonly onChange: (patch: Partial<ConnectorDraft>) => void;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  return (
    <View className="gap-4 rounded-2xl border border-border p-3">
      <TextField
        label="Connector name"
        description={
          props.isNew
            ? "Lowercase letters, numbers, dashes or underscores. Its tools are prefixed with it."
            : "A name cannot change once saved, because saved values belong to it."
        }
        value={draft.name}
        disabled={!props.isNew}
        autoCapitalize="none"
        onChange={(name) => props.onChange({ name: name.toLowerCase() })}
      />
      <View className="gap-2">
        <FieldHeader label="Type" description="Where the connector runs." />
        <ListSection>
          <ChoiceRow
            role="radio"
            icon="globe"
            label="HTTP server (URL)"
            selected={draft.transport === "http"}
            onPress={() => props.onChange({ transport: "http" })}
          />
          <ChoiceRow
            role="radio"
            icon="terminal"
            label="Command (runs on the server)"
            selected={draft.transport === "stdio"}
            onPress={() => props.onChange({ transport: "stdio" })}
          />
        </ListSection>
      </View>
      {draft.transport === "http" ? (
        <>
          <TextField
            label="URL"
            description="The MCP endpoint, http or https."
            value={draft.url}
            autoCapitalize="none"
            onChange={(url) => props.onChange({ url })}
          />
          <RowsEditor
            label="Headers"
            addLabel="Add header"
            keyLabel="Header"
            rows={draft.headers}
            onChange={(headers) => props.onChange({ headers })}
          />
        </>
      ) : (
        <>
          <TextField
            label="Command"
            description="The program that starts the MCP server."
            value={draft.command}
            autoCapitalize="none"
            onChange={(command) => props.onChange({ command })}
          />
          <TextField
            label="Arguments"
            description="One per line."
            value={draft.args}
            multiline
            autoCapitalize="none"
            onChange={(args) => props.onChange({ args })}
          />
          <RowsEditor
            label="Environment variables"
            addLabel="Add variable"
            keyLabel="Variable"
            rows={draft.env}
            onChange={(env) => props.onChange({ env })}
          />
        </>
      )}
      {props.problem ? (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {props.problem}
        </Text>
      ) : null}
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button label="Cancel" tone="secondary" fullWidth onPress={props.onCancel} />
        </View>
        <View className="flex-1">
          <Button
            label={props.isNew ? "Add" : "Done"}
            tone="primary"
            fullWidth
            onPress={props.onDone}
          />
        </View>
      </View>
    </View>
  );
}

/** The assistant's own MCP servers; edits stay in the draft until the assistant is saved. */
export function AssistantConnectorsSection(props: {
  readonly value: ReadonlyArray<ConnectorDraft>;
  readonly onChange: (next: ReadonlyArray<ConnectorDraft>) => void;
}) {
  // index -1 is a connector being added.
  const [editing, setEditing] = useState<{ index: number; draft: ConnectorDraft } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const commit = () => {
    if (editing === null) return;
    const next =
      editing.index === -1
        ? [...props.value, editing.draft]
        : props.value.map((entry, i) => (i === editing.index ? editing.draft : entry));
    const found = connectorDraftsProblem(next);
    if (found !== null) return setProblem(found);
    props.onChange(next);
    setEditing(null);
  };
  const open = (index: number, draft: ConnectorDraft) => {
    setProblem(null);
    setEditing({ index, draft });
  };

  return (
    <View className="gap-2">
      <FieldHeader
        label="Connectors"
        description={`MCP servers only this assistant gets, next to T3's own tools. ${CONNECTORS_PROVIDER_NOTE}`}
      />
      <ListSection>
        {props.value.map((connector, index) => (
          <View key={connector.name} className="flex-row items-center bg-grouped-card">
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${connector.name}`}
              onPress={() => open(index, connector)}
              className="min-w-0 flex-1 bg-grouped-card"
            >
              <ListRowLayout
                icon={connector.transport === "http" ? "globe" : "terminal"}
                label={connector.name}
                description={`${CONNECTOR_TRANSPORT_LABELS[connector.transport]}${connector.enabled ? "" : " · Off"}`}
                accessory={
                  <SymbolView
                    name="pencil"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                }
              />
            </RowPressable>
            <ThemedSwitch
              accessibilityLabel={`${connector.name} enabled`}
              value={connector.enabled}
              onValueChange={(enabled) =>
                props.onChange(
                  props.value.map((entry, i) => (i === index ? { ...entry, enabled } : entry)),
                )
              }
            />
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${connector.name}`}
              onPress={() => props.onChange(props.value.filter((_, i) => i !== index))}
              className="px-4 py-3"
            >
              <SymbolView
                name="trash"
                size={16}
                tintColorClassName="accent-danger-foreground"
                type="monochrome"
              />
            </RowPressable>
          </View>
        ))}
        <ListActionRow
          icon="plus"
          label="Add connector"
          onPress={() => open(-1, emptyConnectorDraft())}
        />
      </ListSection>
      {editing === null ? null : (
        <ConnectorForm
          draft={editing.draft}
          isNew={editing.index === -1}
          problem={problem}
          onChange={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
          onDone={commit}
          onCancel={() => setEditing(null)}
        />
      )}
    </View>
  );
}
