import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** What ran out of tries on a chat channel, with a way to send it again; nothing when all arrived. */
export function UndeliveredRepliesRow(props: {
  readonly label: string | null;
  readonly canAct: boolean;
  readonly onResend: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.label === null) return null;
  const resend = async () => {
    setBusy(true);
    setError(null);
    const reply = await props.onResend();
    setBusy(false);
    if (!reply.ok) setError(reply.message);
  };
  return (
    <SettingsRow
      title="Undelivered replies"
      description={<span className="text-warning-foreground">{props.label}</span>}
      status={
        error ? (
          <span role="alert" className="text-destructive-foreground">
            {error}
          </span>
        ) : undefined
      }
      control={
        <Button
          variant="outline"
          size="sm"
          disabled={!props.canAct || busy}
          onClick={() => void resend()}
        >
          <RotateCwIcon />
          Resend
        </Button>
      }
    />
  );
}
