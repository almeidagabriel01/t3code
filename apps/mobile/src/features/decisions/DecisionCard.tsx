import {
  describeSettledDecision,
  formatDecisionExpiry,
} from "@t3tools/client-runtime/state/decisions";
import type { Decision, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useDecisionActions } from "../../state/decisions";
import { useLiveThreadLinkLabels } from "../../state/entities";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

/** Long context folds behind "Show more" instead of pushing the options off screen. */
const CONTEXT_FOLD_LENGTH = 280;
const CONTEXT_FOLDED_HEIGHT = 96;

function Context(props: { readonly markdown: string; readonly environmentId: EnvironmentId }) {
  const [expanded, setExpanded] = useState(false);
  const styles = useMarkdownPreviewStyles();
  const markdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const openLink = useOpenPullRequest();
  if (props.markdown.trim() === "") return null;
  const foldable =
    props.markdown.length > CONTEXT_FOLD_LENGTH || props.markdown.split("\n").length > 5;
  return (
    <View className="items-start gap-1">
      <View
        className="w-full overflow-hidden"
        style={foldable && !expanded ? { maxHeight: CONTEXT_FOLDED_HEIGHT } : undefined}
      >
        <SelectableMarkdownText
          markdown={markdown}
          textStyle={styles.nativeTextStyle}
          onLinkPress={(href) => void openLink(href)}
        />
      </View>
      {foldable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          className="active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Heading(props: {
  readonly decision: Decision;
  readonly onOpenThread?: (() => void) | undefined;
}) {
  const { decision } = props;
  const nowMs = useNowMinuteMs();
  const expiry =
    decision.status === "open" && decision.expiresAt !== undefined
      ? formatDecisionExpiry(decision.expiresAt, nowMs)
      : null;
  return (
    <View className="gap-1">
      <Text className="font-t3-bold text-lg text-foreground">{decision.title}</Text>
      <View className="flex-row items-center gap-1.5">
        {props.onOpenThread ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open thread ${decision.threadTitle}`}
            hitSlop={8}
            onPress={props.onOpenThread}
            className="min-w-0 shrink active:opacity-70"
          >
            <Text
              className="font-sans text-xs text-foreground-secondary underline"
              numberOfLines={1}
            >
              {decision.threadTitle}
            </Text>
          </Pressable>
        ) : (
          <Text
            className="min-w-0 shrink font-sans text-xs text-foreground-muted"
            numberOfLines={1}
          >
            {decision.threadTitle}
          </Text>
        )}
        {expiry ? (
          <Text className="font-sans text-xs text-foreground-muted">· {expiry}</Text>
        ) : null}
      </View>
    </View>
  );
}

export interface DecisionCardProps {
  readonly environmentId: EnvironmentId;
  readonly decision: Decision;
  /** Opens the requesting thread; omitted where the card already sits in it. */
  readonly onOpenThread?: (() => void) | undefined;
}

function OpenCard(props: DecisionCardProps) {
  const { decision } = props;
  const actions = useDecisionActions(props.environmentId);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"answer" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = note.trim();
  const off = !actions.canAct || busy !== null;

  const run = async (kind: "answer" | "dismiss") => {
    setBusy(kind);
    setError(null);
    const reply =
      kind === "answer"
        ? await actions.answer(decision.id, {
            ...(optionId === null ? {} : { optionId }),
            ...(text === "" ? {} : { text }),
          })
        : await actions.dismiss(decision.id);
    setBusy(null);
    // The settled decision arrives on the stream and replaces this card; a refusal stays here.
    if (!reply.ok) setError(reply.message);
  };

  return (
    <View className="gap-3">
      <Heading decision={decision} onOpenThread={props.onOpenThread} />
      <Context markdown={decision.context} environmentId={props.environmentId} />
      <View accessibilityRole="radiogroup" className="gap-1">
        {decision.options.map((option) => {
          const selected = optionId === option.id;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: off }}
              accessibilityLabel={[
                option.label,
                decision.recommended === option.id ? "Recommended" : null,
                option.consequence ?? null,
              ]
                .filter(Boolean)
                .join(", ")}
              disabled={off}
              onPress={() => setOptionId(option.id)}
              className={cn(
                "min-h-12 flex-row items-start gap-3 rounded-2xl px-2 py-2.5 active:bg-subtle",
                selected && "bg-subtle",
                off && "opacity-60",
              )}
            >
              <View className="pt-0.5">
                <SymbolView
                  name={selected ? "checkmark.circle.fill" : "circle.dashed"}
                  size={20}
                  tintColorClassName={selected ? "accent-focus" : "accent-icon-muted"}
                />
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="font-t3-medium text-base text-foreground">{option.label}</Text>
                  {decision.recommended === option.id ? (
                    <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
                      Recommended
                    </Text>
                  ) : null}
                </View>
                {option.consequence ? (
                  <Text className="font-sans text-xs leading-normal text-foreground-muted">
                    {option.consequence}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {noteOpen ? (
        <View className="gap-1.5">
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            Other answer or note
          </Text>
          <TextInput
            accessibilityLabel="Other answer or note"
            value={note}
            multiline
            maxLength={2000}
            editable={!off}
            onChangeText={setNote}
            className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
          />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setNoteOpen(true)}
          className="self-start active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-secondary">
            Other answer or add a note
          </Text>
        </Pressable>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row items-center justify-end gap-2.5">
        <Button
          label="Dismiss"
          tone="text"
          disabled={off}
          loading={busy === "dismiss"}
          onPress={() => void run("dismiss")}
        />
        <Button
          label="Answer"
          tone="primary"
          disabled={off || (optionId === null && text === "")}
          loading={busy === "answer"}
          onPress={() => void run("answer")}
        />
      </View>
    </View>
  );
}

function SettledCard(props: DecisionCardProps) {
  const { outcome, detail } = describeSettledDecision(props.decision);
  return (
    <View className="gap-1.5">
      <Heading decision={props.decision} onOpenThread={props.onOpenThread} />
      <Text className="font-sans text-xs text-foreground-muted">
        <Text className="font-t3-medium text-foreground-secondary">{outcome}</Text>
        {detail ? ` · ${detail}` : null}
      </Text>
    </View>
  );
}

/** One decision an agent put to the user: answer it, dismiss it, or read how it ended. */
export function DecisionCard(props: DecisionCardProps) {
  return (
    <View className="rounded-[20px] border border-border bg-card-alt p-4">
      {props.decision.status === "open" ? <OpenCard {...props} /> : <SettledCard {...props} />}
    </View>
  );
}
