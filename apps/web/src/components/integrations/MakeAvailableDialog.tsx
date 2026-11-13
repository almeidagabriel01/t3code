import { integrationErrorMessage } from "@t3tools/client-runtime/integrations";
import type { DetectedServer, IntegrationMakeAvailableResult } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import type { IntegrationReply } from "../../state/integrations";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function Part(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{props.label}</span>
      <div className="text-sm text-muted-foreground">{props.children}</div>
    </div>
  );
}

/**
 * Consent for copying a server found elsewhere into T3, naming exactly what is copied. A server
 * T3 must sign in to itself turns the dialog into a Connect step, so the sign-in tab opens from
 * a fresh click instead of after an await (Safari blocks that).
 */
export function MakeAvailableDialog(props: {
  readonly server: DetectedServer;
  readonly onConfirm: () => Promise<IntegrationReply<IntegrationMakeAvailableResult>>;
  readonly onConnect: (catalogId: string) => void;
  readonly onClose: () => void;
}) {
  const { server } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectId, setConnectId] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setError(null);
    const result = await props.onConfirm();
    setPending(false);
    if (!result.ok) setError(integrationErrorMessage(result.reason, server.name));
    else if (result.value.outcome === "connect") setConnectId(result.value.catalogId);
  };
  const target = server.url ?? server.command ?? null;
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Make available to all providers</DialogTitle>
          <DialogDescription>{server.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {target === null ? null : (
              <Part label="Copies">
                <code className="break-all text-xs">{target}</code>
              </Part>
            )}
            {server.secretKeys.length === 0 ? null : (
              <Part label="Values saved as T3 secrets">{server.secretKeys.join(", ")}</Part>
            )}
            {server.needsValue.length === 0 ? null : (
              <Part label="Left out (with ${...})">{server.needsValue.join(", ")}</Part>
            )}
            {error === null ? null : (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={pending} onClick={props.onClose}>
            Cancel
          </Button>
          {connectId === null ? (
            <Button disabled={pending} onClick={() => void confirm()}>
              Make available to all providers
            </Button>
          ) : (
            <Button onClick={() => props.onConnect(connectId)}>Connect</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
