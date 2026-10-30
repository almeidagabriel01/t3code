import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { ClaudeChromeDialog, useClaudeChrome } from "../claudeChrome/ClaudeChromeDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function ClaudeChromeSettingsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { status, canSet, setEnabled } = useClaudeChrome(props.environmentId, props.instanceId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        title="Claude in Chrome"
        description={
          status.error !== null
            ? "Status unavailable. Open Manage to retry."
            : "Lets Claude use your Chrome. Applies to new sessions for this account."
        }
        control={
          <div className="flex items-center gap-3">
            <Switch
              aria-label="Claude in Chrome enabled by default"
              checked={status.data?.enabledByDefault ?? false}
              disabled={!canSet || status.data === null}
              onCheckedChange={(checked) => void setEnabled(checked)}
            />
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Manage
            </Button>
          </div>
        }
      />
      <ClaudeChromeDialog
        environmentId={props.environmentId}
        instanceId={props.instanceId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
