import { ASSISTANT_AVATAR_MAX_BYTES, AssistantError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const AVATAR_EXTENSIONS = ["png", "jpg", "webp"] as const;
export type AvatarExtension = (typeof AVATAR_EXTENSIONS)[number];

const AVATAR_MIME_BY_EXTENSION: Record<AvatarExtension, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

const invalid = (message: string) => new AssistantError({ reason: "invalid", message });

/** The format named by the file's own bytes, never by what the client called it. */
function sniffAvatarImage(bytes: Uint8Array): AvatarExtension | null {
  const at = (offset: number, ...expected: ReadonlyArray<number>) =>
    expected.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

/** Ids reach a file name, so only the plain characters server ids use are accepted. */
const SAFE_ASSISTANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const avatarsDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "assistant-avatars");
});

/** The stored image of an assistant, or null when it has none. */
export const findAvatarFile = Effect.fn("AssistantAvatars.find")(function* (assistantId: string) {
  if (!SAFE_ASSISTANT_ID.test(assistantId)) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* avatarsDir;
  for (const extension of AVATAR_EXTENSIONS) {
    const file = path.join(dir, `${assistantId}.${extension}`);
    if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
      return { path: file, mimeType: AVATAR_MIME_BY_EXTENSION[extension] };
    }
  }
  return null;
});

export const removeAvatarImages = Effect.fn("AssistantAvatars.remove")(function* (
  assistantId: string,
) {
  if (!SAFE_ASSISTANT_ID.test(assistantId)) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* avatarsDir;
  for (const extension of AVATAR_EXTENSIONS) {
    yield* fileSystem
      .remove(path.join(dir, `${assistantId}.${extension}`), { force: true })
      .pipe(Effect.ignore);
  }
});

/**
 * Takes a finished upload (`attachments.createUploadUrl`), checks its size and bytes, and keeps a
 * copy under the state dir: pending uploads are swept after a while, so the upload itself cannot
 * be the avatar. The upload is deleted once copied.
 */
export const storeAvatarImage = Effect.fn("AssistantAvatars.store")(function* (input: {
  readonly assistantId: string;
  readonly attachmentId: string;
}) {
  if (!SAFE_ASSISTANT_ID.test(input.assistantId)) return yield* invalid("Unknown assistant.");
  if (
    parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return yield* invalid("Upload the image first, then pass its attachment id.");
  }
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (source === null) return yield* invalid("That upload is gone. Pick the image again.");
  const failed = () =>
    new AssistantError({ reason: "storage", message: "Could not save the image." });
  const info = yield* fileSystem.stat(source).pipe(Effect.mapError(failed));
  if (Number(info.size) > ASSISTANT_AVATAR_MAX_BYTES) {
    return yield* invalid(
      `The image is larger than ${ASSISTANT_AVATAR_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const bytes = yield* fileSystem.readFile(source).pipe(Effect.mapError(failed));
  if (bytes.byteLength > ASSISTANT_AVATAR_MAX_BYTES) {
    return yield* invalid(
      `The image is larger than ${ASSISTANT_AVATAR_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const extension = sniffAvatarImage(bytes);
  if (extension === null) return yield* invalid("Use a PNG, JPEG or WebP image.");
  const dir = yield* avatarsDir;
  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError(failed));
  yield* removeAvatarImages(input.assistantId);
  yield* fileSystem
    .writeFile(path.join(dir, `${input.assistantId}.${extension}`), bytes)
    .pipe(Effect.mapError(failed));
  yield* fileSystem.remove(source, { force: true }).pipe(Effect.ignore);
  return extension;
});
