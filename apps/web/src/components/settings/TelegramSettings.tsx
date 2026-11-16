import {
  compactTelegramUserId,
  telegramDeliveryErrorReason,
  telegramSenderLabel,
  telegramStatusLabel,
  telegramSwitchHint,
  telegramUndeliveredLabel,
} from "@t3tools/client-runtime/state/telegramChannel";
import type {
  EnvironmentId,
  TelegramChannelSettings,
  TelegramPendingSender,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleHelpIcon,
  InfoIcon,
  KeyRoundIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  UserRoundCheckIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import {
  useTelegramActions,
  useTelegramEnvironmentIds,
  useTelegramSettings,
  type TelegramReply,
} from "../../state/telegramChannel";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChannelLanguageRow } from "./ChannelLanguageRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ASSISTANT_SETTINGS_COPY } from "./settingsSearchAssistantItems";
import { searchableSetting, settingCopy } from "./settingsSearch";
import { UndeliveredRepliesRow } from "./UndeliveredRepliesRow";

const SECTION_ICON = "size-4 text-muted-foreground";

/** The failed reply as a sentence, with how long ago it happened when that is known. */
function deliveryNote(
  error: NonNullable<TelegramChannelSettings["lastDeliveryError"]>,
  nowMs: number = Date.now(),
): string {
  const when = formatRelativeTimeLabel(error.at, nowMs);
  return `The last reply was not delivered (${when ? `${when}, ` : ""}${telegramDeliveryErrorReason(error)}).`;
}

function FieldError({ message }: { readonly message: string | null }) {
  return message ? (
    <span role="alert" className="text-destructive-foreground">
      {message}
    </span>
  ) : null;
}

function TokenSection(props: {
  readonly configured: boolean;
  readonly canAct: boolean;
  readonly save: (input: {
    readonly botToken?: string;
    readonly clearToken?: boolean;
  }) => Promise<TelegramReply>;
  readonly suffix: string;
}) {
  const { configured, canAct, save } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const botToken = draft.trim();
    if (botToken === "") return;
    const reply = await save({ botToken });
    if (!reply.ok) return setError(reply.message);
    setError(null);
    setDraft("");
  };

  const remove = async () => {
    const reply = await save({ clearToken: true });
    setError(reply.ok ? null : reply.message);
  };

  return (
    <SettingsSection
      title={`${settingCopy("telegram-bot-token").title}${props.suffix}`}
      icon={<KeyRoundIcon className={SECTION_ICON} />}
    >
      <SettingsRow
        // oxlint-disable-next-line t3code/require-searchable-settings-copy -- status badge, not a setting
        title={
          <span className="inline-flex items-center gap-2">
            {settingCopy("telegram-bot-token").title}
            <Badge variant={configured ? "success" : "warning"} size="sm">
              {configured ? "Saved" : "Not set"}
            </Badge>
          </span>
        }
        description={
          configured
            ? ASSISTANT_SETTINGS_COPY.telegramTokenSaved
            : settingCopy("telegram-bot-token").description
        }
        status={<FieldError message={error} />}
        control={
          <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-80">
            <Input
              aria-label="Bot token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={configured ? "New bot token" : "123456789:ABC…"}
              value={draft}
              disabled={!canAct}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
            <Button
              variant="outline"
              disabled={!canAct || draft.trim() === ""}
              onClick={() => void submit()}
            >
              {configured ? "Replace" : "Save"}
            </Button>
          </div>
        }
      />
      {configured ? (
        <SettingsRow
          {...settingCopy("telegram-remove-token")}
          control={
            <Button variant="destructive-outline" disabled={!canAct} onClick={() => void remove()}>
              <Trash2Icon />
              Remove token
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function PendingSection(props: {
  readonly senders: ReadonlyArray<TelegramPendingSender>;
  readonly userIds: ReadonlyArray<string>;
  readonly canAct: boolean;
  readonly save: (input: {
    readonly allowedUserIds?: ReadonlyArray<string>;
    readonly dismissUserIds?: ReadonlyArray<string>;
  }) => Promise<TelegramReply>;
  readonly suffix: string;
}) {
  const { senders, userIds, canAct, save } = props;
  const [error, setError] = useState<string | null>(null);
  if (senders.length === 0) return null;

  const settle = async (input: Parameters<typeof save>[0]) => {
    const reply = await save(input);
    setError(reply.ok ? null : reply.message);
  };

  return (
    <SettingsSection
      title={`${settingCopy("telegram-waiting").title}${props.suffix}`}
      icon={<UserRoundCheckIcon className={SECTION_ICON} />}
    >
      <SettingsRow
        {...settingCopy("telegram-pending-senders")}
        status={<FieldError message={error} />}
      />
      {senders.map((sender) => {
        const when = formatRelativeTimeLabel(sender.lastSeenAt);
        const name = telegramSenderLabel(sender);
        return (
          // A plain row: SettingsRow stacks its control under the title in a narrow panel.
          <div
            key={sender.userId}
            className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {[sender.firstName && sender.username ? `@${sender.username}` : null, when]
                  .filter(Boolean)
                  .join(" · ") || `Id ${sender.userId}`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                aria-label={`Allow ${name}`}
                disabled={!canAct}
                onClick={() => void settle({ allowedUserIds: [...userIds, sender.userId] })}
              >
                <CheckIcon />
                Allow
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Ignore ${name}`}
                      disabled={!canAct}
                      onClick={() => void settle({ dismissUserIds: [sender.userId] })}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup side="top">Ignore {name}</TooltipPopup>
              </Tooltip>
            </span>
          </div>
        );
      })}
    </SettingsSection>
  );
}

function UserIdSection(props: {
  readonly userIds: ReadonlyArray<string>;
  readonly canAct: boolean;
  readonly save: (userIds: ReadonlyArray<string>) => Promise<TelegramReply>;
  readonly suffix: string;
}) {
  const { userIds, canAct, save } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const id = compactTelegramUserId(draft);
    if (id === "") return;
    if (userIds.includes(id)) return setError("That one is already on the list.");
    const reply = await save([...userIds, id]);
    if (!reply.ok) return setError(reply.message);
    setError(null);
    setDraft("");
  };

  const remove = async (id: string) => {
    const reply = await save(userIds.filter((item) => item !== id));
    setError(reply.ok ? null : reply.message);
  };

  return (
    <SettingsSection
      title={`${settingCopy("telegram-who-can-write").title}${props.suffix}`}
      icon={<UserRoundIcon className={SECTION_ICON} />}
    >
      <SettingsRow
        {...settingCopy("telegram-user-ids")}
        status={<FieldError message={error} />}
        control={
          <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
            <Input
              aria-label="Telegram user ids"
              inputMode="numeric"
              placeholder="123456789"
              value={draft}
              disabled={!canAct}
              onChange={(event) => setDraft(compactTelegramUserId(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
              }}
            />
            <Button variant="outline" disabled={!canAct} onClick={() => void add()}>
              <PlusIcon />
              Add
            </Button>
          </div>
        }
      />
      {userIds.length === 0 ? (
        <SettingsRow
          // oxlint-disable-next-line t3code/require-searchable-settings-copy -- empty state, not a setting
          title="No user ids yet"
        />
      ) : (
        userIds.map((id) => (
          // A plain row: SettingsRow stacks its control under the title in a narrow panel.
          <div key={id} className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
            <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
              {id}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${id}`}
                    disabled={!canAct}
                    onClick={() => void remove(id)}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove {id}</TooltipPopup>
            </Tooltip>
          </div>
        ))
      )}
    </SettingsSection>
  );
}

function TelegramEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
  readonly first: boolean;
}) {
  const { environmentId, suffix } = props;
  const { settings, error, refresh } = useTelegramSettings(environmentId);
  const actions = useTelegramActions(environmentId);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- another client can change the settings, so a cached read is refetched on open
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (settings === null) {
    return (
      <SettingsSection
        title={`${settingCopy("telegram").title}${suffix}`}
        icon={<SendIcon className={SECTION_ICON} />}
      >
        <SettingsRow
          // oxlint-disable-next-line t3code/require-searchable-settings-copy -- loading and error state, not a setting
          title={error ? "Telegram settings could not be loaded" : "Loading Telegram settings…"}
          description={error ?? undefined}
        />
      </SettingsSection>
    );
  }

  const { canAct } = actions;
  const hint = telegramSwitchHint(settings);
  const settled = async (input: Parameters<typeof actions.configure>[0]) => {
    const reply = await actions.configure(input);
    if (reply.ok) refresh();
    return reply;
  };
  const toggle = async (enabled: boolean) => {
    const reply = await settled({ enabled });
    setSwitchError(reply.ok ? null : reply.message);
  };

  return (
    <>
      <SettingsSection
        {...(props.first ? { id: searchableSetting("telegram").id } : {})}
        title={`${settingCopy("telegram").title}${suffix}`}
        icon={<SendIcon className={SECTION_ICON} />}
      >
        <SettingsRow
          {...settingCopy("telegram-status")}
          // oxlint-disable-next-line t3code/require-searchable-settings-copy -- live status readout, not a setting
          description={
            <span
              className={settings.status === "error" ? "text-destructive-foreground" : undefined}
            >
              {telegramStatusLabel(settings)}
              {settings.status === "running" && settings.botUsername
                ? ` as @${settings.botUsername}`
                : ""}
            </span>
          }
          status={
            settings.lastDeliveryError ? (
              <span className="text-warning-foreground">
                {deliveryNote(settings.lastDeliveryError)}
              </span>
            ) : undefined
          }
        />
        <UndeliveredRepliesRow
          label={telegramUndeliveredLabel(settings)}
          canAct={actions.canResend}
          onResend={actions.resendUndelivered}
        />
        <SettingsRow
          title={settingCopy("telegram-use").title}
          description={hint ?? settingCopy("telegram-use").description}
          status={<FieldError message={switchError} />}
          control={
            <Switch
              aria-label="Use Telegram"
              checked={settings.enabled}
              disabled={!canAct || (hint !== null && !settings.enabled)}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
            />
          }
        />
        <ChannelLanguageRow environmentId={environmentId} disabled={!canAct} page="telegram" />
      </SettingsSection>

      <TokenSection
        configured={settings.tokenConfigured}
        canAct={canAct}
        save={settled}
        suffix={suffix}
      />

      <PendingSection
        senders={settings.pendingSenders ?? []}
        userIds={settings.allowedUserIds}
        canAct={canAct}
        save={settled}
        suffix={suffix}
      />

      <UserIdSection
        userIds={settings.allowedUserIds}
        canAct={canAct}
        save={(allowedUserIds) => settled({ allowedUserIds })}
        suffix={suffix}
      />
    </>
  );
}

export function TelegramSettingsPanel() {
  const environmentIds = useTelegramEnvironmentIds();
  const { environments } = useEnvironments();
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return (
    <SettingsPageContainer>
      {environmentIds.length === 0 ? (
        <SettingsSection
          title={settingCopy("telegram").title}
          icon={<SendIcon className={SECTION_ICON} />}
        >
          <SettingsRow
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- unavailable state, not a setting
            title="Telegram is not available"
            // oxlint-disable-next-line t3code/require-searchable-settings-copy -- unavailable state, not a setting
            description="Connect to a T3 Code server that supports Telegram, then its settings appear here."
          />
        </SettingsSection>
      ) : (
        <>
          <p className="px-3 text-sm leading-normal text-muted-foreground sm:px-4">
            Talk to your assistants from Telegram, on any computer. Start a message with @Name to
            pick an assistant; Jarvis answers otherwise, and the chat stays with the last assistant
            you picked. Send @ on its own to list your assistants, or use the / menu in Telegram.
            Works while T3 Code is running.
          </p>
          {environmentIds.map((id, index) => (
            <TelegramEnvironment
              key={id}
              environmentId={id}
              suffix={environmentIds.length > 1 ? ` · ${labelOf(id)}` : ""}
              first={index === 0}
            />
          ))}
          <SettingsSection
            {...searchableSetting("telegram-setup")}
            icon={<CircleHelpIcon className={SECTION_ICON} />}
          >
            <SettingsRow {...searchableSetting("telegram-setup-create")} />
            <SettingsRow {...searchableSetting("telegram-setup-token")} />
            <SettingsRow {...searchableSetting("telegram-setup-message")} />
            <SettingsRow {...searchableSetting("telegram-setup-allow")} />
          </SettingsSection>
          <SettingsSection
            {...searchableSetting("telegram-good-to-know")}
            icon={<InfoIcon className={SECTION_ICON} />}
          >
            <SettingsRow {...searchableSetting("telegram-limits")} />
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}
