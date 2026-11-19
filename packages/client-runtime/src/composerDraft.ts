/**
 * What a composer draft holds that the user put there. Model, mode and workspace picks are
 * settings, not content, so the caller leaves them out.
 */
export interface DraftContent {
  readonly prompt: string;
  readonly attachmentCount: number;
  readonly contextCount: number;
}

/** Whether a thread, assistant or group draft counts as unsent work, on every client. */
export function draftHasUserContent(draft: DraftContent): boolean {
  return draft.prompt.trim().length > 0 || draft.attachmentCount > 0 || draft.contextCount > 0;
}
