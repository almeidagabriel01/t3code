const IMAGE_REF_PATTERN = /!\[([^\]\n]*)\]\(t3-attachment:([a-z0-9][a-z0-9_-]*)\)/gi;
const SRC_PATTERN = /^t3-attachment:([a-z0-9][a-z0-9_-]*)$/i;

/** Markdown for an uploaded attachment, resolved to a signed asset URL by each client. */
export function attachmentImageMarkdown(name: string, attachmentId: string): string {
  return `![${name.replace(/[[\]\n]/g, " ").trim()}](t3-attachment:${attachmentId})`;
}

export function parseAttachmentImageSrc(src: string): string | null {
  return SRC_PATTERN.exec(src.trim())?.[1] ?? null;
}

export function attachmentImageIds(text: string): ReadonlyArray<string> {
  return [...new Set(Array.from(text.matchAll(IMAGE_REF_PATTERN), (match) => match[2]!))];
}

export function replaceAttachmentImageIds(
  text: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return text.replace(IMAGE_REF_PATTERN, (ref, name: string, id: string) => {
    const next = replacements.get(id);
    return next === undefined ? ref : attachmentImageMarkdown(name, next);
  });
}
