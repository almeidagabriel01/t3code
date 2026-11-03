import type { EnvironmentId, KanbanCardId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import { pickComposerFiles } from "../../lib/composerImages";
import { useKanbanActions } from "./useKanbanActions";

async function uploadPicked(environmentId: EnvironmentId, onProgress: (value: number) => void) {
  const added: Array<{
    attachmentId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];
  let failure: string | null = null;
  try {
    const picked = await pickComposerFiles({ existingCount: 0 });
    failure = picked.error;
    for (const file of picked.files) {
      const prepared = await prepareTurnAttachments({
        environmentId,
        attachments: [file],
        supportsImageUploads: true,
        onUploadProgress: (_, value) => onProgress(value),
      });
      const uploaded = prepared.status === "ready" ? prepared.attachments[0] : undefined;
      if (uploaded === undefined || !("id" in uploaded) || uploaded.id === undefined) {
        throw new Error(`Upload failed for '${file.name}'.`);
      }
      added.push({
        attachmentId: uploaded.id,
        name: file.name,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
      });
    }
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : "Upload failed.";
  }
  return { added, failure };
}

/** Same as web: upload each file, then one patch adds the uploaded ones to the card. */
export function KanbanAddAttachmentButton(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: KanbanCardId;
}) {
  const { updateCard } = useKanbanActions(props.environmentId);
  const [progress, setProgress] = useState<number | null>(null);
  const run = async () => {
    setProgress(0);
    const { added, failure: uploadFailure } = await uploadPicked(props.environmentId, setProgress);
    let failure = uploadFailure;
    if (added.length > 0 && !(await updateCard({ cardId: props.cardId, addAttachments: added }))) {
      failure = failure ?? "The card could not keep the file.";
    }
    setProgress(null);
    if (failure !== null) Dialog.alert("Could not add the attachment", failure);
  };
  return (
    <Button
      label={progress === null ? "Add attachment" : `Uploading ${Math.round(progress * 100)}%`}
      icon="paperclip"
      tone="text"
      loading={progress !== null}
      onPress={() => void run()}
    />
  );
}
