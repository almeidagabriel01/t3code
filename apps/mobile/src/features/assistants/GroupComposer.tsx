import {
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupRecipientsPreview,
  insertAssistantGroupMention,
} from "@t3tools/client-runtime/assistantGroupChat";
import {
  ASSISTANT_GROUP_MESSAGE_MAX_CHARS,
  type Assistant,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { AssistantAvatar } from "./assistantPresentation";

export const MENTION_REQUIRED_COPY = "Mention a member with @, or set a lead in Edit group.";

export type GroupSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** The group's message box: `@` picks members, and a line says who will get the message. */
export function GroupComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly replyingTo: { readonly name: string } | null;
  readonly onClearReply: () => void;
  readonly onSend: (text: string) => Promise<GroupSendResult>;
}) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  // Set only for the render that follows a pick, so the caret lands after the inserted mention.
  const [forcedCaret, setForcedCaret] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lead = props.members.find((member) => member.id === props.leadId) ?? null;
  const mention = assistantGroupMentionQuery(text, caret);
  const options =
    mention === null ? [] : assistantGroupMentionOptions(mention.query, props.members);
  const preview = assistantGroupRecipientsPreview(
    text,
    props.members,
    lead,
    props.replyingTo?.name ?? null,
  );
  const canSend = !props.disabled && !sending && text.trim() !== "";

  const pick = (index: number) => {
    const option = options[index];
    if (mention === null || option === undefined) return;
    const next = insertAssistantGroupMention(text, mention, option);
    setText(next.text);
    setCaret(next.caret);
    setForcedCaret(next.caret);
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const result = await props.onSend(text.trim());
    setSending(false);
    if (result.ok) {
      setText("");
      setCaret(0);
    } else setError(result.message);
  };

  return (
    <View className="gap-1.5 px-3 pb-2 pt-2">
      {props.replyingTo === null ? null : (
        <View className="flex-row items-center gap-1.5">
          <Text testID="group-reply-chip" className="text-xs font-t3-medium text-primary-text">
            Replying to {props.replyingTo.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel reply"
            hitSlop={8}
            onPress={props.onClearReply}
            className="active:opacity-70"
          >
            <SymbolView
              name="xmark.circle.fill"
              size={16}
              tintColorClassName="accent-icon-subtle"
            />
          </Pressable>
        </View>
      )}
      {options.length === 0 ? null : (
        <ScrollView
          keyboardShouldPersistTaps="always"
          className="max-h-52 rounded-xl border border-border bg-sheet"
        >
          {options.map((option, index) => (
            <Pressable
              key={option.kind === "everyone" ? "everyone" : option.member.id}
              accessibilityRole="button"
              accessibilityLabel={
                option.kind === "everyone" ? "Mention everyone" : `Mention ${option.member.name}`
              }
              onPress={() => pick(index)}
              className="min-h-11 flex-row items-center gap-2 px-3 active:opacity-70"
            >
              {option.kind === "everyone" ? (
                <>
                  <SymbolView name="person.2" size={18} tintColorClassName="accent-icon-subtle" />
                  <Text className="text-sm font-t3-medium text-foreground">@everyone</Text>
                </>
              ) : (
                <>
                  <AssistantAvatar
                    assistant={option.member}
                    environmentId={props.environmentId}
                    size={22}
                  />
                  <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
                    {option.member.name}
                  </Text>
                  {option.member.role === "" ? null : (
                    <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                      {option.member.role}
                    </Text>
                  )}
                  {option.member.id === props.leadId ? (
                    <Text className="ml-auto text-xs text-foreground-muted">lead</Text>
                  ) : null}
                </>
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View className="flex-row items-end gap-2">
        <TextInput
          accessibilityLabel="Message the group"
          placeholder={props.disabledReason ?? "Message the group. Type @ to pick who gets it."}
          editable={!props.disabled}
          multiline
          maxLength={ASSISTANT_GROUP_MESSAGE_MAX_CHARS}
          value={text}
          {...(forcedCaret === null ? {} : { selection: { start: forcedCaret, end: forcedCaret } })}
          onChangeText={(value) => {
            setText(value);
            setError(null);
          }}
          onSelectionChange={(event) => {
            setForcedCaret(null);
            setCaret(event.nativeEvent.selection.start);
          }}
          className="max-h-32 min-h-11 min-w-0 flex-1 rounded-2xl border border-border px-3 py-2 text-base text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!canSend}
          onPress={() => void send()}
          className="size-11 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-40"
        >
          <SymbolView name="arrow.up" size={18} tintColorClassName="accent-primary-foreground" />
        </Pressable>
      </View>
      {error === null ? (
        <Text testID="group-recipients" className="min-h-4 text-xs text-foreground-muted">
          {preview}
        </Text>
      ) : (
        <Text accessibilityRole="alert" className="min-h-4 text-xs text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}
