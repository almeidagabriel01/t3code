import type { EnvironmentId, MemorySpaceId } from "@t3tools/contracts";
import { memoryRuleScopeLabel, type MemoryRuleItem } from "@t3tools/client-runtime/memory-browsing";

import { MemoryEditor } from "../settings/MemorySettings";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

export default function LearnedRuleEditDialog({
  environmentId,
  memorySpaceId,
  rule,
  onClose,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  rule: MemoryRuleItem;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit rule</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <MemoryEditor
            item={rule}
            scopeLabel={memoryRuleScopeLabel(rule.scope)}
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            onClose={onClose}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
