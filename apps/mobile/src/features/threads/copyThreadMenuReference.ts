import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";

import * as Dialog from "../../components/ui/Dialog";
import { copyThreadReference } from "../../lib/copyThreadReference";

export function copyThreadMenuReference(thread: EnvironmentThreadShell): void {
  const target = threadChipCopyTarget(
    { environmentId: thread.environmentId, threadId: thread.id },
    thread.title,
  );
  void copyThreadReference(target).then((didCopy) => {
    if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
  });
}
