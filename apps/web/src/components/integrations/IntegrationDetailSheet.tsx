import {
  integrationErrorMessage,
  integrationProviderSupport,
  integrationStatusLabel,
  notAvailableOnLabel,
} from "@t3tools/client-runtime/integrations";
import type { IntegrationView } from "@t3tools/contracts";
import { UnplugIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { IntegrationReply } from "../../state/integrations";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { IntegrationIcon, TONE_BADGE } from "./IntegrationRow";

export interface IntegrationProviderInstance {
  readonly displayName: string;
  readonly driverKind: string;
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-foreground/12 py-3">
      <span className="text-sm font-medium">{props.label}</span>
      <div className="text-sm text-muted-foreground">{props.children}</div>
    </div>
  );
}

/** Confirms a disconnect, naming how many assistants lose it. */
export function DisconnectConfirm(props: {
  readonly title: string;
  readonly assistantsUsing: number;
  readonly onConfirm: () => Promise<IntegrationReply>;
  readonly onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {props.title}?</AlertDialogTitle>
          <AlertDialogDescription>
            Assistants using it: {props.assistantsUsing}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              const result = await props.onConfirm();
              setPending(false);
              if (result.ok) props.onClose();
              else setError(integrationErrorMessage(result.reason, props.title));
            }}
          >
            Disconnect
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** A T3 integration's state, where it reaches, who uses it, and the way out. */
export function IntegrationDetailSheet(props: {
  readonly integration: IntegrationView;
  readonly title: string;
  readonly icon: { readonly svg: string; readonly color: string } | null;
  readonly providers: ReadonlyArray<IntegrationProviderInstance>;
  readonly usedBy: ReadonlyArray<string>;
  readonly canAct: boolean;
  readonly onAvailability: (availability: IntegrationView["availability"]) => void;
  readonly onDisconnect: () => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const { integration } = props;
  const status = integrationStatusLabel(integration.status);
  const worksOn = props.providers.filter((provider) =>
    integrationProviderSupport(provider.driverKind),
  );
  const notOn = props.providers.filter(
    (provider) => !integrationProviderSupport(provider.driverKind),
  );
  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup side="right" variant="inset">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-3 pe-8">
            <IntegrationIcon icon={props.icon} />
            <SheetTitle className="min-w-0">{props.title}</SheetTitle>
          </div>
          <SheetDescription render={<div />}>
            <Badge variant={TONE_BADGE[status.tone]} size="sm">
              {status.label}
            </Badge>
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          {integration.expiresAt === undefined ? null : (
            <Field label="Expires">{new Date(integration.expiresAt).toLocaleString()}</Field>
          )}
          {integration.scope === undefined ? null : (
            <Field label="Access">
              <span className="break-words">{integration.scope}</span>
            </Field>
          )}
          <div className="flex flex-col gap-1.5 border-t border-foreground/12 py-3">
            <span id={`${id}-available`} className="text-sm font-medium">
              Available to
            </span>
            <RadioGroup
              aria-labelledby={`${id}-available`}
              value={integration.availability}
              disabled={!props.canAct}
              onValueChange={(value) =>
                props.onAvailability(value === "all" ? "all" : "assistants")
              }
            >
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8">
                <Radio value="assistants" />
                Assistants only
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-hidden hover:bg-foreground/8">
                <Radio value="all" />
                All threads
              </label>
            </RadioGroup>
          </div>
          {worksOn.length === 0 && notOn.length === 0 ? null : (
            <Field label="Works on">
              <ul className="flex flex-col gap-0.5">
                {worksOn.map((provider) => (
                  <li key={provider.displayName}>{provider.displayName}</li>
                ))}
                {notOn.map((provider) => (
                  <li key={provider.displayName} className="text-warning-foreground">
                    {notAvailableOnLabel(provider.displayName)}
                  </li>
                ))}
              </ul>
            </Field>
          )}
          {props.usedBy.length === 0 ? null : (
            <Field label="Used by">
              <ul className="flex flex-col gap-0.5">
                {props.usedBy.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </Field>
          )}
          <div className="border-t border-foreground/12 pt-3">
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!props.canAct}
              onClick={props.onDisconnect}
            >
              <UnplugIcon />
              Disconnect
            </Button>
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
