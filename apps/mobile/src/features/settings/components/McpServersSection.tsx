import { useAtomValue } from "@effect/atom-react";
import {
  draftFor,
  serverFromDraft,
  supportedProviders,
  type Draft,
} from "@t3tools/client-runtime/mcpServerDrafts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { t3McpProviderName, type EnvironmentId, type T3McpServer } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import * as Dialog from "../../../components/ui/Dialog";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { RowPressable } from "../../../components/ui/RowPressable";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { ChoiceRow, FieldHeader, TextField } from "../../assistants/AssistantFormFields";

const SECRET_MASK = "••••••";
const INPUT_CLASS = "min-h-8 flex-1 font-sans text-base text-foreground";
const NOT_SUPPORTED_NOTE = "OpenCode, Pi, and Muse do not support MCP servers added here.";

function newEntryId() {
  return `entry-${Math.random().toString(36).slice(2)}`;
}

function EntriesEditor(props: {
  readonly label: string;
  readonly addLabel: string;
  readonly keyLabel: string;
  readonly entries: Draft["entries"];
  readonly onChange: (entries: Draft["entries"]) => void;
}) {
  const patch = (index: number, next: Partial<Draft["entries"][number]>) =>
    props.onChange(props.entries.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));
  return (
    <View className="gap-2">
      <FieldHeader
        label={props.label}
        description="Values are stored on the server and shown masked. Leave a saved value as it is to keep it."
      />
      <ListSection>
        {props.entries.map((entry, index) => (
          <View key={entry.id} className="flex-row items-center gap-2 bg-grouped-card px-4">
            <TextInput
              accessibilityLabel={`${props.keyLabel} ${index + 1}`}
              placeholder={props.keyLabel}
              value={entry.key}
              readOnly={entry.value === SECRET_MASK}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(key) => patch(index, { key })}
              placeholderTextColorClassName="accent-foreground-muted"
              className={INPUT_CLASS}
            />
            <TextInput
              accessibilityLabel={`${props.keyLabel} ${index + 1} value`}
              placeholder="Value"
              value={entry.value}
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
              onPress={() => props.onChange(props.entries.filter((_, i) => i !== index))}
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
          onPress={() =>
            props.onChange([...props.entries, { id: newEntryId(), key: "", value: "" }])
          }
        />
      </ListSection>
    </View>
  );
}

function ServerForm(props: {
  readonly draft: Draft;
  readonly isNew: boolean;
  readonly problem: string | null;
  readonly saving: boolean;
  readonly onChange: (patch: Partial<Draft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  return (
    <View className="gap-4 rounded-2xl border border-border p-3">
      <TextField
        label="Server name"
        description={
          props.isNew
            ? `Lowercase letters, numbers, or hyphens. Agents see it as ${t3McpProviderName(draft.name || "name")}.`
            : "A name cannot change once saved, because saved values belong to it."
        }
        value={draft.name}
        disabled={!props.isNew}
        autoCapitalize="none"
        onChange={(name) => props.onChange({ name: name.toLowerCase() })}
      />
      <View className="gap-2">
        <FieldHeader label="Type" description="Where the server runs." />
        <ListSection>
          <ChoiceRow
            role="radio"
            icon="terminal"
            label="Command (stdio)"
            selected={draft.transport === "stdio"}
            onPress={() => props.onChange({ transport: "stdio", entries: [] })}
          />
          <ChoiceRow
            role="radio"
            icon="globe"
            label="HTTP server (URL)"
            selected={draft.transport === "http"}
            onPress={() => props.onChange({ transport: "http", entries: [] })}
          />
        </ListSection>
      </View>
      {draft.transport === "stdio" ? (
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
        </>
      ) : (
        <TextField
          label="URL"
          description="The MCP endpoint over HTTPS. Put tokens in headers, not in the URL."
          value={draft.url}
          autoCapitalize="none"
          onChange={(url) => props.onChange({ url })}
        />
      )}
      <EntriesEditor
        label={draft.transport === "stdio" ? "Environment variables" : "Headers"}
        addLabel={draft.transport === "stdio" ? "Add variable" : "Add header"}
        keyLabel={draft.transport === "stdio" ? "Variable" : "Header"}
        entries={draft.entries}
        onChange={(entries) => props.onChange({ entries })}
      />
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
            label={props.isNew ? "Add" : "Save"}
            tone="primary"
            fullWidth
            disabled={props.saving}
            onPress={props.onSave}
          />
        </View>
      </View>
    </View>
  );
}

/** The environment's global MCP servers: every provider session there gets the enabled ones. */
export function McpServersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title?: string | undefined;
}) {
  const { environmentId } = props;
  const servers = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.mcpServers;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  // originalName undefined is a server being added.
  const [editing, setEditing] = useState<{
    readonly originalName: string | undefined;
    readonly draft: Draft;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const write = async (name: string, server: T3McpServer | null) => {
    if (!canWrite || saving) return false;
    setSaving(true);
    setProblem(null);
    const result = await update({
      environmentId,
      input: { patch: { mcpServers: { [name]: server } } },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setProblem(String(squashAtomCommandFailure(result)));
      return false;
    }
    return true;
  };

  const commit = async () => {
    if (editing === null) return;
    const result = serverFromDraft(
      editing.draft,
      new Set(Object.keys(servers ?? {})),
      editing.originalName,
    );
    if ("error" in result) return setProblem(result.error);
    if (await write(result.name, result.server)) setEditing(null);
  };

  const open = (originalName: string | undefined) => {
    setProblem(null);
    setEditing({
      originalName,
      draft: draftFor(originalName, originalName ? servers?.[originalName] : undefined),
    });
  };

  return (
    <View className="gap-2">
      <ListSection
        title={props.title ? `MCP servers · ${props.title}` : "MCP servers"}
        footer={`Every provider session on this environment gets the enabled servers. ${NOT_SUPPORTED_NOTE}`}
      >
        {Object.entries(servers ?? {}).map(([name, server]) => (
          <View key={name} className="flex-row items-center bg-grouped-card">
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${name}`}
              disabled={!canWrite}
              onPress={() => open(name)}
              className="min-w-0 flex-1 bg-grouped-card"
            >
              <ListRowLayout
                icon={server.transport === "http" ? "globe" : "terminal"}
                label={name}
                description={`${server.transport === "http" ? "HTTP" : "Command"} · ${supportedProviders(server.transport)}`}
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
              accessibilityLabel={`${name} enabled`}
              disabled={!canWrite || saving}
              value={server.enabled}
              onValueChange={(enabled) => void write(name, { ...server, enabled })}
            />
            <RowPressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${name}`}
              disabled={!canWrite || saving}
              onPress={() =>
                Dialog.confirm({
                  title: `Remove ${name}?`,
                  message: "This removes the server and its stored secrets from this environment.",
                  confirmText: "Remove",
                  destructive: true,
                  onConfirm: () => void write(name, null),
                })
              }
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
          label="Add MCP server"
          disabled={!canWrite}
          onPress={() => open(undefined)}
        />
      </ListSection>
      {editing === null ? (
        problem ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-2 text-danger-foreground"
          >
            {problem}
          </Text>
        ) : null
      ) : (
        <ServerForm
          draft={editing.draft}
          isNew={editing.originalName === undefined}
          problem={problem}
          saving={saving}
          onChange={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
          onSave={() => void commit()}
          onCancel={() => setEditing(null)}
        />
      )}
    </View>
  );
}
