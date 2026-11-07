import type { EnvironmentId } from "@t3tools/contracts";

import { prepareTurnAttachments } from "../../lib/attachmentUpload";
import { pickComposerImages, type DraftComposerImageAttachment } from "../../lib/composerImages";
import { avatarImageProblem } from "./assistantDraft";

/** One image from the photo library, or the reason it cannot be an avatar. */
export async function pickAvatarImage(): Promise<
  | { readonly image: DraftComposerImageAttachment; readonly problem: null }
  | { readonly image: null; readonly problem: string | null }
> {
  const picked = await pickComposerImages({ existingCount: 0 });
  const image = picked.images[0];
  if (image === undefined) return { image: null, problem: picked.error };
  const problem = avatarImageProblem(image);
  return problem === null ? { image, problem: null } : { image: null, problem };
}

/** Uploads the picked image and returns the attachment id `assistants.setAvatarImage` takes. */
export async function uploadAvatarImage(
  environmentId: EnvironmentId,
  image: DraftComposerImageAttachment,
): Promise<string> {
  const prepared = await prepareTurnAttachments({
    environmentId,
    attachments: [image],
    supportsImageUploads: true,
  });
  const uploaded = prepared.status === "ready" ? prepared.attachments[0] : undefined;
  if (uploaded === undefined || !("id" in uploaded) || uploaded.id === undefined)
    throw new Error("The image upload failed.");
  return uploaded.id;
}
