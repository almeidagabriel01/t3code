import { integrationErrorMessage, parsePastedCallback } from "@t3tools/client-runtime/integrations";
import {
  INTEGRATIONS_CALLBACK_PATH,
  type IntegrationCatalogEntry,
  type IntegrationsState,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const LINK_CLASS =
  "inline-flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-sm text-foreground/80 underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function ExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{props.children}</span>
    </a>
  );
}

function FormDialog(props: {
  readonly title: string;
  readonly description?: string;
  readonly formId: string;
  readonly submitLabel: string;
  readonly canSubmit: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly extraAction?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && !props.pending && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description === undefined ? null : (
            <DialogDescription>{props.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          <form
            id={props.formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (props.canSubmit && !props.pending) props.onSubmit();
            }}
          >
            {props.children}
            {props.error === null ? null : (
              <Alert variant="error">
                <AlertDescription>{props.error}</AlertDescription>
              </Alert>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {props.extraAction}
          <Button variant="outline" disabled={props.pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" form={props.formId} disabled={!props.canSubmit || props.pending}>
            {props.submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Paste mode: nothing listens on the redirect, so the user brings the address back. */
export function PasteDialog(props: {
  readonly name: string;
  readonly onComplete: (callbackUrl: string) => Promise<IntegrationReply<unknown>>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const callbackUrl = parsePastedCallback(text);
    if (callbackUrl === null)
      return setError(integrationErrorMessage("invalid-callback", props.name));
    setPending(true);
    setError(null);
    const result = await props.onComplete(callbackUrl);
    setPending(false);
    if (!result.ok) setError(integrationErrorMessage(result.reason, props.name));
  };
  return (
    <FormDialog
      title={props.name}
      formId={`${id}-paste`}
      submitLabel="Connect"
      canSubmit={text.trim() !== ""}
      pending={pending}
      error={error}
      onSubmit={() => void submit()}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-address`}>Paste the address from the browser</Label>
        <Input
          id={`${id}-address`}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </FormDialog>
  );
}

function CopyRow(props: { readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md border border-foreground/12 py-1 ps-2.5 pe-1">
      <code className="min-w-0 flex-1 truncate text-xs">{props.value}</code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Copy"
        onClick={() => copyToClipboard(props.value, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </li>
  );
}

/** Redirect URIs this environment may use: the loopback one, plus this page's server callback. */
export function ownAppRedirectUris(
  state: Pick<IntegrationsState, "loopbackRedirectUri">,
  pageOrigin: string | null,
): ReadonlyArray<string> {
  return pageOrigin === null
    ? [state.loopbackRedirectUri]
    : [state.loopbackRedirectUri, `${pageOrigin}${INTEGRATIONS_CALLBACK_PATH}`];
}

/** Own-app setup: the secret is write-only; an untouched secret field keeps the saved one. */
export function OwnAppDialog(props: {
  readonly entry: IntegrationCatalogEntry;
  readonly clientGroup: string;
  readonly saved: IntegrationsState["ownApps"][number] | null;
  readonly redirectUris: ReadonlyArray<string>;
  readonly setupUrl: string | null;
  readonly onSave: (input: {
    readonly clientId: string;
    readonly clientSecret?: string;
  }) => Promise<IntegrationReply<unknown>>;
  readonly onRemove: () => Promise<IntegrationReply<unknown>>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [clientId, setClientId] = useState(props.saved?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settle = async (run: () => Promise<IntegrationReply<unknown>>) => {
    setPending(true);
    setError(null);
    const result = await run();
    setPending(false);
    if (!result.ok) setError(integrationErrorMessage(result.reason, props.entry.name));
  };
  return (
    <FormDialog
      title="Use your own app"
      description={props.entry.name}
      formId={`${id}-own-app`}
      submitLabel="Save"
      canSubmit={clientId.trim() !== ""}
      pending={pending}
      error={error}
      onSubmit={() =>
        void settle(() =>
          props.onSave({
            clientId: clientId.trim(),
            ...(secret === "" ? {} : { clientSecret: secret }),
          }),
        )
      }
      onClose={props.onClose}
      extraAction={
        props.saved === null ? null : (
          <Button
            variant="destructive-outline"
            className="sm:me-auto"
            disabled={pending}
            onClick={() => void settle(props.onRemove)}
          >
            Remove app
          </Button>
        )
      }
    >
      {props.setupUrl === null ? null : (
        <ExternalLink href={props.setupUrl}>{props.setupUrl}</ExternalLink>
      )}
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-redirects`} className="text-sm font-medium">
          Redirect URIs to register
        </span>
        <ul aria-labelledby={`${id}-redirects`} className="flex flex-col gap-1">
          {props.redirectUris.map((uri) => (
            <CopyRow key={uri} value={uri} />
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-client-id`}>Client ID</Label>
        <Input
          id={`${id}-client-id`}
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-client-secret`}>Client secret</Label>
        <Input
          id={`${id}-client-secret`}
          type="password"
          autoComplete="new-password"
          aria-describedby={props.saved?.hasClientSecret ? `${id}-secret-saved` : undefined}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        {props.saved?.hasClientSecret ? (
          <p id={`${id}-secret-saved`} className="text-xs text-muted-foreground">
            Saved
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}

/** Token sign-in; the token goes to the server's secret store and is never shown again. */
export function TokenDialog(props: {
  readonly entry: IntegrationCatalogEntry;
  readonly onSave: (token: string) => Promise<IntegrationReply<unknown>>;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenUrl =
    (props.entry.auth.kind === "token" ? props.entry.auth.tokenUrl : undefined) ??
    props.entry.tokenFallback?.tokenUrl ??
    null;
  const submit = async () => {
    setPending(true);
    setError(null);
    const result = await props.onSave(token.trim());
    setPending(false);
    if (!result.ok) setError(integrationErrorMessage(result.reason, props.entry.name));
  };
  return (
    <FormDialog
      title="Use a token instead"
      description={props.entry.name}
      formId={`${id}-token`}
      submitLabel="Connect"
      canSubmit={token.trim() !== ""}
      pending={pending}
      error={error}
      onSubmit={() => void submit()}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-token-field`}>Token</Label>
        <Input
          id={`${id}-token-field`}
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </div>
      {tokenUrl === null ? null : <ExternalLink href={tokenUrl}>Create a token</ExternalLink>}
    </FormDialog>
  );
}
