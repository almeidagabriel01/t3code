import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "~/state/server";
import { fileAttachmentStagingLimit } from "./composerAttachmentFiles";

// undefined: no config yet; null: the server takes no files. A number, so provider updates to the
// same config do not re-render the reader.
const advertisedFileBytesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): number | null | undefined => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return config == null
      ? undefined
      : (config.environment.capabilities.fileAttachments?.maxUploadBytes ?? null);
  }),
);

/** What an environment takes as attachments, as a composer outside `ChatView` needs it. */
export function useFileAttachmentCapabilities(environmentId: EnvironmentId) {
  const advertised = useAtomValue(advertisedFileBytesAtom(environmentId));
  const capabilities = {
    attachmentUploadsCapabilityKnown: advertised !== undefined,
    supportsAttachmentUploads: advertised !== undefined,
    maxFileAttachmentBytes: advertised == null ? null : clampFileAttachmentUploadBytes(advertised),
  };
  return { ...capabilities, fileStagingLimit: fileAttachmentStagingLimit(capabilities) };
}
