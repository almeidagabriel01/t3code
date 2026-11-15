import { useState } from "react";

import { SettingsActionRow } from "./SettingsActionRow";

/** What ran out of tries on a chat channel, with a way to send it again; nothing when all arrived. */
export function UndeliveredRepliesRow(props: {
  readonly label: string | null;
  readonly disabled: boolean;
  readonly onResend: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
  readonly onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (props.label === null) return null;
  const resend = async () => {
    setBusy(true);
    const reply = await props.onResend();
    setBusy(false);
    props.onError(reply.ok ? null : reply.message);
  };
  return (
    <SettingsActionRow
      icon="arrow.clockwise"
      label="Resend undelivered replies"
      description={props.label}
      disabled={props.disabled}
      loading={busy}
      onPress={() => void resend()}
    />
  );
}
