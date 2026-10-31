import type { EnvironmentId, SlackChannelSettings } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  LinkIcon,
  PlusIcon,
  SlackIcon,
  Trash2Icon,
  UnlinkIcon,
  UsersIcon,
  WrenchIcon,
  HashIcon,
  KeyRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironments } from "../../state/environments";
import {
  useSlackActions,
  useSlackEnvironmentIds,
  useSlackIdentities,
  useSlackSettings,
  type SlackReply,
} from "../../state/slackChannel";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SecretInput } from "./SecretInput";
import {
  parseChannelId,
  SLACK_APP_MANIFEST,
  slackDeliveryErrorLabel,
  slackStatusLabel,
} from "./SlackSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SECTION_ICON = "size-4 text-muted-foreground";

function FieldError({ message }: { readonly message: string | null }) {
  return message ? (
    <span role="alert" className="text-destructive-foreground">
      {message}
    </span>
  ) : null;
}

function SetupGuide() {
  const [open, setOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "Slack app manifest" });
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex min-h-10 w-full items-center gap-1.5 rounded-xl px-3 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        Create the Slack app
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-3 border-t border-border/50 px-3 py-3 sm:px-4">
          <ol className="list-decimal space-y-1.5 ps-5 text-xs leading-normal text-muted-foreground">
            <li>Go to api.slack.com/apps and create an app from the manifest below.</li>
            <li>
              In Basic Information, under App-Level Tokens, create a token with the
              connections:write scope. That is the App token.
            </li>
            <li>Install the app to your workspace. That gives you the Bot token.</li>
          </ol>
          <div className="relative">
            <pre
              aria-label="Slack app manifest"
              className="overflow-x-auto rounded-lg border border-foreground/12 bg-foreground/4 p-3 pe-24 font-mono text-xs leading-relaxed"
            >
              {SLACK_APP_MANIFEST}
            </pre>
            <Button
              size="xs"
              variant="outline"
              className="absolute end-2 top-2"
              onClick={() => copyToClipboard(SLACK_APP_MANIFEST, undefined)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
              {isCopied ? "Copied" : "Copy manifest"}
            </Button>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function SlackEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
  readonly first: boolean;
}) {
  const { environmentId, suffix } = props;
  const { settings, error, refresh } = useSlackSettings(environmentId);
  const actions = useSlackActions(environmentId);
  const connectionId = settings?.connectionId ?? null;
  const identities = useSlackIdentities(environmentId, connectionId);
  const refreshIdentities = identities.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tokens and links change on other clients, so a cached read is refetched on open
  useEffect(() => {
    refresh();
    refreshIdentities();
  }, [refresh, refreshIdentities]);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState("");
  const [channelError, setChannelError] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<{ code: string; minutes: number } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const settled = async <A,>(run: Promise<SlackReply<A>>) => {
    const reply = await run;
    if (reply.ok) refresh();
    return reply;
  };

  if (settings === null) {
    return (
      <SettingsSection title={`Slack${suffix}`} icon={<SlackIcon className={SECTION_ICON} />}>
        <SettingsRow
          title={error ? "Slack settings could not be loaded" : "Loading Slack settings…"}
          description={error ?? undefined}
        />
      </SettingsSection>
    );
  }

  const canAct = actions.canAct;
  const tokensSaved = settings.hasAppToken && settings.hasBotToken;
  const anyTokenSaved = settings.hasAppToken || settings.hasBotToken;
  const typed = appToken.trim() !== "" || botToken.trim() !== "";
  const mutate = (settings: SlackChannelSettings) => settings.allowedChannelIds;

  const saveTokens = async () => {
    const reply = await settled(
      actions.configure({
        ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      }),
    );
    if (!reply.ok) return setTokenError(reply.message);
    setTokenError(null);
    setAppToken("");
    setBotToken("");
  };

  const removeTokens = async () => {
    const confirmed = await requestConfirmDialog(
      "Remove the Slack tokens?\nThe bot disconnects and stops answering. You can add tokens again at any time.",
      { variant: "destructive" },
    );
    if (confirmed === false) return;
    const reply = await settled(actions.disconnect());
    if (!reply.ok) return setTokenError(reply.message);
    setTokenError(null);
  };

  const toggle = async (enabled: boolean) => {
    const reply = await settled(actions.configure({ enabled }));
    setSwitchError(reply.ok ? null : reply.message);
  };

  const saveChannels = async (allowedChannelIds: ReadonlyArray<string>) =>
    settled(actions.configure({ allowedChannelIds: allowedChannelIds as never }));

  const addChannel = async () => {
    const parsed = parseChannelId(channelDraft, mutate(settings));
    if (!parsed.ok) return setChannelError(parsed.message);
    const reply = await saveChannels([...settings.allowedChannelIds, parsed.id]);
    if (!reply.ok) return setChannelError(reply.message);
    setChannelError(null);
    setChannelDraft("");
  };

  const removeChannel = async (id: string) => {
    const reply = await saveChannels(settings.allowedChannelIds.filter((item) => item !== id));
    setChannelError(reply.ok ? null : reply.message);
  };

  const makeLinkCode = async () => {
    const reply = await actions.createLinkCode(settings.connectionId);
    if (!reply.ok) return setLinkError(reply.message);
    setLinkError(null);
    setLinkCode({
      code: reply.value.code,
      minutes: Math.max(1, Math.round((Date.parse(reply.value.expiresAt) - Date.now()) / 60_000)),
    });
  };

  const unlink = async (externalActorId: string) => {
    const reply = await actions.unlink(settings.connectionId, externalActorId);
    if (reply.ok) identities.refresh();
    else setLinkError(reply.message);
  };

  return (
    <>
      <SettingsSection
        {...(props.first ? { id: searchableSetting("slack").id } : {})}
        title={`Slack${suffix}`}
        icon={<SlackIcon className={SECTION_ICON} />}
      >
        <SettingsRow
          title="Status"
          description={
            <span
              className={settings.status === "error" ? "text-destructive-foreground" : undefined}
            >
              {slackStatusLabel(settings)}
            </span>
          }
          status={
            settings.lastDeliveryError ? (
              <span className="text-warning-foreground">
                {slackDeliveryErrorLabel(settings.lastDeliveryError)}
              </span>
            ) : undefined
          }
        />
        <SettingsRow
          title="Use Slack"
          description={
            tokensSaved
              ? "Answer messages sent to the bot."
              : "Save both tokens below before turning this on."
          }
          status={<FieldError message={switchError} />}
          control={
            <Switch
              aria-label="Use Slack"
              checked={settings.enabled}
              disabled={!canAct || !tokensSaved}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title={`Tokens${suffix}`}
        icon={<KeyRoundIcon className={SECTION_ICON} />}
        headerAction={
          anyTokenSaved ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canAct}
              onClick={() => void removeTokens()}
            >
              <Trash2Icon />
              Remove tokens
            </Button>
          ) : null
        }
      >
        {(
          [
            ["App token", "xapp-…", settings.hasAppToken, appToken, setAppToken],
            ["Bot token", "xoxb-…", settings.hasBotToken, botToken, setBotToken],
          ] as const
        ).map(([label, hint, saved, value, setValue]) => (
          <SettingsRow
            key={label}
            title={
              <span className="inline-flex items-center gap-2">
                {label}
                {saved ? (
                  <Badge variant="success" size="sm">
                    Saved
                  </Badge>
                ) : null}
              </span>
            }
            description="Stored on the server and never shown again."
            control={
              <div className="w-full @min-[32rem]/settings-row:w-72">
                <SecretInput
                  aria-label={label}
                  configured={saved}
                  placeholder={hint}
                  value={value}
                  disabled={!canAct}
                  onChange={(event) => setValue(event.target.value)}
                />
              </div>
            }
          />
        ))}
        <SettingsRow
          title="Save tokens"
          description="Slack checks the tokens before they are stored. Fill in only the ones you want to set or replace."
          status={<FieldError message={tokenError} />}
          control={
            <Button disabled={!canAct || !typed} onClick={() => void saveTokens()}>
              Save
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={`Channels${suffix}`} icon={<HashIcon className={SECTION_ICON} />}>
        <SettingsRow
          title="Channels"
          description="Channel IDs where @mentions are answered. Direct messages always work. In Slack, open the channel details and copy the Channel ID at the bottom."
          status={<FieldError message={channelError} />}
          control={
            <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
              <Input
                aria-label="Channel ID"
                placeholder="C0123456789"
                font="mono"
                value={channelDraft}
                disabled={!canAct}
                onChange={(event) => setChannelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addChannel();
                }}
              />
              <Button variant="outline" disabled={!canAct} onClick={() => void addChannel()}>
                <PlusIcon />
                Add
              </Button>
            </div>
          }
        />
        {settings.allowedChannelIds.length === 0 ? (
          <SettingsRow
            title="No channels yet"
            description="The bot answers direct messages only."
          />
        ) : (
          settings.allowedChannelIds.map((id) => (
            <SettingsRow
              key={id}
              title={<span className="font-mono">{id}</span>}
              control={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove ${id}`}
                        disabled={!canAct}
                        onClick={() => void removeChannel(id)}
                      />
                    }
                  >
                    <Trash2Icon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Remove {id}</TooltipPopup>
                </Tooltip>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title={`Linked accounts${suffix}`}
        icon={<UsersIcon className={SECTION_ICON} />}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canAct}
            onClick={() => void makeLinkCode()}
          >
            <LinkIcon />
            Link your Slack account
          </Button>
        }
      >
        {linkCode ? (
          <SettingsRow
            title="Your link code"
            description={
              <>
                Send <code className="font-mono">link {linkCode.code}</code> to the bot in a direct
                message. The code expires in {linkCode.minutes}{" "}
                {linkCode.minutes === 1 ? "minute" : "minutes"}.
              </>
            }
            control={
              <span
                aria-label="Link code"
                className="font-mono text-2xl font-semibold tracking-widest text-foreground"
              >
                {linkCode.code}
              </span>
            }
          />
        ) : null}
        {linkError ? (
          <SettingsRow title="Could not link" status={<FieldError message={linkError} />} />
        ) : null}
        {(identities.data ?? []).length === 0 ? (
          <SettingsRow
            title="No linked accounts"
            description="Link your Slack account so the bot knows who you are."
          />
        ) : (
          (identities.data ?? []).map((identity) => (
            <SettingsRow
              key={identity.externalActorId}
              title={`Slack user ${identity.externalActorId}`}
              description={[
                identity.displayName,
                `Linked ${formatRelativeTimeLabel(identity.linkedAt)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Unlink ${identity.externalActorId}`}
                        disabled={!canAct}
                        onClick={() => void unlink(identity.externalActorId)}
                      />
                    }
                  >
                    <UnlinkIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Unlink {identity.externalActorId}</TooltipPopup>
                </Tooltip>
              }
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

export function SlackSettingsPanel() {
  const environmentIds = useSlackEnvironmentIds();
  const { environments } = useEnvironments();
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return (
    <SettingsPageContainer>
      {environmentIds.length === 0 ? (
        <SettingsSection title="Slack" icon={<SlackIcon className={SECTION_ICON} />}>
          <SettingsRow
            title="Slack is not available"
            description="Connect to a server that supports Slack, then its settings appear here."
          />
        </SettingsSection>
      ) : (
        <>
          <p className="px-3 text-sm leading-normal text-muted-foreground sm:px-4">
            Talk to your assistants from Slack. Message the bot directly or @mention it in a
            channel. Start a message with @Name to talk to a specific assistant; otherwise Jarvis
            answers, and the conversation stays with the last assistant you picked.
          </p>
          {environmentIds.map((id, index) => (
            <SlackEnvironment
              key={id}
              environmentId={id}
              suffix={environmentIds.length > 1 ? ` · ${labelOf(id)}` : ""}
              first={index === 0}
            />
          ))}
          <SettingsSection title="Set up" icon={<WrenchIcon className={SECTION_ICON} />}>
            <SetupGuide />
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}
