interface TimelineJump {
  readonly threadKey: string;
  readonly jumpToMessage: (messageId: string) => void;
}

let attached: TimelineJump | null = null;

/** The timeline showing a thread registers here so chrome outside it can scroll to a message. */
export function attachTimelineJump(timeline: TimelineJump): () => void {
  attached = timeline;
  return () => {
    if (attached === timeline) attached = null;
  };
}

export function jumpToTimelineMessage(threadKey: string, messageId: string): void {
  if (attached?.threadKey === threadKey) attached.jumpToMessage(messageId);
}
