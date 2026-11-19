import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { ClaudeChromeDialog, useClaudeChrome } from "../claudeChrome/ClaudeChromeDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { settingCopy } from "./settingsSearch";
import { PROVIDER_SETTINGS_COPY } from "./settingsSearchProviderItems";

export function ClaudeChromeSettingsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { status, canSet, setEnabled } = useClaudeChrome(props.environmentId, props.instanceId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        title={settingCopy("claude-in-chrome").title}
        description={
          status.error !== null
            ? PROVIDER_SETTINGS_COPY.claudeChromeUnavailable
            : settingCopy("claude-in-chrome").description
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
