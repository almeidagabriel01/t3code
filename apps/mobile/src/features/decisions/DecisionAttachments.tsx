import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  DecisionId,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { pickComposerFiles, pickComposerMedia } from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import {
  appendComposerDraftAttachments,
  clearComposerDraft,
  composerDraftsAtom,
  removeComposerDraftAttachment,
} from "../../state/use-composer-drafts";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";

/** Environment ids end the key before its last colon, which is how uploads find their server. */
export const decisionAttachmentDraftKey = (environmentId: EnvironmentId, decisionId: DecisionId) =>
  `${environmentId}:decision-${encodeURIComponent(decisionId)}`;

/**
 * The files picked for one decision's answer, kept as a composer draft so uploads run in the
 * background. Takes ids rather than the thread selection: cards also render outside any thread.
 */
export function useDecisionAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly decisionId: DecisionId;
  readonly approval: boolean;
}) {
  const key = decisionAttachmentDraftKey(input.environmentId, input.decisionId);
  const configs = useServerConfigs();
  const drafts = useAtomValue(composerDraftsAtom);
  const [picking, setPicking] = useState(false);
  const capabilities = configs.get(input.environmentId)?.environment.capabilities;
  const attachments = drafts[key]?.attachments ?? [];
  const uploaded = attachments.flatMap((attachment) =>
    attachment.uploadedAttachmentId && attachment.uploadEnvironmentId === input.environmentId
      ? [
          {
            type: attachment.type,
            id: attachment.uploadedAttachmentId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          } as ChatImageAttachment | ChatFileAttachment,
        ]
      : [],
  );
  const pick = async (kind: "media" | "files") => {
    setPicking(true);
    const settled = await settlePromise(async () => {
      const existingCount = appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.length ?? 0;
      const result =
        kind === "files"
          ? await pickComposerFiles({
              existingCount,
              maxBytes: capabilities?.fileAttachments?.maxUploadBytes,
            })
          : await pickComposerMedia({
              existingCount,
              maxVideoBytes: capabilities?.fileAttachments?.maxUploadBytes,
            });
      const picked = "files" in result ? result.files : result.attachments;
      const rejected = appendComposerDraftAttachments(key, picked);
      if (result.error || rejected > 0) {
        Dialog.alert("Could not attach file", result.error ?? "Too many attachments.");
      }
    });
    setPicking(false);
    if (AsyncResult.isFailure(settled)) {
      const error = squashAtomCommandFailure(settled);
      Dialog.alert("Could not attach file", error instanceof Error ? error.message : "Try again.");
    }
  };
  return {
    key,
    attachments,
    uploaded,
    /** False while a pick is open or any file is still uploading or failed. */
    settled: !picking && uploaded.length === attachments.length,
    // An approval mirror has no channel for files.
    canAttach: capabilities !== undefined && !input.approval,
    pick,
    clear: () => clearComposerDraft(key),
  };
}

export function DecisionAttachmentControls(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReturnType<typeof useDecisionAttachments>;
  readonly disabled: boolean;
}) {
  const { attachments } = props;
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-1">
        <ComposerAttachmentButton
          disabled={props.disabled}
          supportsFiles
          onPickMedia={() => attachments.pick("media")}
          onPickFiles={() => attachments.pick("files")}
        />
        <Text className="font-t3-medium text-xs text-foreground-secondary">Attach files</Text>
      </View>
      <ComposerAttachmentStrip
        environmentId={props.environmentId}
        attachments={attachments.attachments}
        onRemove={(id) => {
          if (!props.disabled) removeComposerDraftAttachment(attachments.key, id);
        }}
      />
    </View>
  );
}
