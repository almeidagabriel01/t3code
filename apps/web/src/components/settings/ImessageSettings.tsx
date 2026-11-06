import {
  compactImessageHandle,
  formatImessageHandleInput,
  imessageDefaultCallingCode,
  imessageSuggestedSelfHandles,
} from "@t3tools/client-runtime/state/imessageChannel";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  AtSignIcon,
  InfoIcon,
  MessageCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import {
  useImessageAccess,
  useImessageActions,
  useImessageEnvironmentIds,
  useImessageSettings,
  type ImessageReply,
} from "../../state/imessageChannel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  imessageAccessState,
  imessageDeliveryErrorLabel,
  imessageErrorLabel,
  imessageStatusLabel,
  imessageSwitchHint,
} from "./ImessageSettings.logic";
import { ChannelLanguageRow } from "./ChannelLanguageRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SECTION_ICON = "size-4 text-muted-foreground";
// Desktop puts its own en-US first in navigator.languages; the OS locale names the real region.
const CALLING_CODE = imessageDefaultCallingCode([
  ...(typeof window === "undefined" ? [] : [window.desktopBridge?.getSystemLocale() ?? ""]),
  ...(typeof navigator === "undefined" ? [] : navigator.languages),
  Intl.DateTimeFormat().resolvedOptions().locale,
]);

function FieldError({ message }: { readonly message: string | null }) {
  return message ? (
    <span role="alert" className="text-destructive-foreground">
      {message}
    </span>
  ) : null;
}

function HandleSection(props: {
  readonly title: string;
  readonly label: string;
  readonly description: string;
  readonly emptyTitle: string;
  readonly icon: React.ReactNode;
  readonly handles: ReadonlyArray<string>;
  /** Handles found on the Mac that one click adds. */
  readonly suggestions?: ReadonlyArray<string>;
  readonly canAct: boolean;
  readonly save: (handles: ReadonlyArray<string>) => Promise<ImessageReply>;
}) {
  const { handles, canAct, save, suggestions = [] } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const handle = compactImessageHandle(draft);
    if (handle === "") return;
    if (handles.some((item) => compactImessageHandle(item) === handle))
      return setError("That one is already on the list.");
    const reply = await save([...handles, handle]);
    if (!reply.ok) return setError(reply.message);
    setError(null);
    setDraft("");
  };

  const addFound = async () => {
    const reply = await save([...handles, ...suggestions]);
    setError(reply.ok ? null : reply.message);
  };

  const remove = async (handle: string) => {
    const reply = await save(handles.filter((item) => item !== handle));
    setError(reply.ok ? null : reply.message);
  };

  return (
    <SettingsSection title={props.title} icon={props.icon}>
      <SettingsRow
        title={props.label}
        description={props.description}
        status={<FieldError message={error} />}
        control={
          <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
            <Input
              aria-label={props.label}
              placeholder="Phone number or email"
              value={draft}
              disabled={!canAct}
              onChange={(event) =>
                setDraft(formatImessageHandleInput(event.target.value, CALLING_CODE))
              }
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
      {suggestions.length > 0 ? (
        <SettingsRow
          title="Found on this Mac"
          description={`Messages here sends from ${suggestions.map((handle) => formatImessageHandleInput(handle)).join(" and ")}.`}
          control={
            <Button variant="outline" disabled={!canAct} onClick={() => void addFound()}>
              <PlusIcon />
              {suggestions.length === 1 ? "Add it" : "Add them"}
            </Button>
          }
        />
      ) : null}
      {handles.length === 0 ? (
        <SettingsRow title={props.emptyTitle} />
      ) : (
        handles.map((handle) => (
          // A plain row: SettingsRow stacks its control under the title in a narrow panel.
          <div key={handle} className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
            <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
              {formatImessageHandleInput(handle)}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${handle}`}
                    disabled={!canAct}
                    onClick={() => void remove(handle)}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove {handle}</TooltipPopup>
            </Tooltip>
          </div>
        ))
      )}
    </SettingsSection>
  );
}

function ImessageEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly suffix: string;
  readonly first: boolean;
}) {
  const { environmentId, suffix } = props;
  const { settings, error, refresh } = useImessageSettings(environmentId);
  const { access, ownHandles, refresh: checkAgain } = useImessageAccess(environmentId);
  const actions = useImessageActions(environmentId);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- handles and permissions change outside this client, so a cached read is refetched on open
  useEffect(() => {
    refresh();
    checkAgain();
  }, [refresh, checkAgain]);

  if (settings === null) {
    return (
      <SettingsSection
        title={`iMessage${suffix}`}
        icon={<MessageCircleIcon className={SECTION_ICON} />}
      >
        <SettingsRow
          title={error ? "iMessage settings could not be loaded" : "Loading iMessage settings…"}
          description={error ?? undefined}
        />
      </SettingsSection>
    );
  }

  const { canAct } = actions;
  const accessState = imessageAccessState(access);
  const handleCount = settings.selfHandles.length + settings.allowedHandles.length;
  const hint = imessageSwitchHint({ granted: accessState.granted, handleCount });
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
        title={`Access${suffix}`}
        icon={<ShieldCheckIcon className={SECTION_ICON} />}
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={() => checkAgain()}>
            <RefreshCwIcon />
            Check again
          </Button>
        }
      >
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              Full Disk Access
              <Badge variant={accessState.granted ? "success" : "warning"} size="sm">
                {accessState.granted ? "Granted" : "Not granted"}
              </Badge>
            </span>
          }
          description={accessState.message ?? "T3 Code can read your messages on this Mac."}
        />
        {settings.lastError === "automation_denied" ||
        settings.lastError === "messages_not_signed_in" ? (
          <SettingsRow
            title="Messages"
            description={
              <span className="text-destructive-foreground">
                {imessageErrorLabel(settings.lastError)}
              </span>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        {...(props.first ? { id: searchableSetting("imessage").id } : {})}
        title={`iMessage${suffix}`}
        icon={<MessageCircleIcon className={SECTION_ICON} />}
      >
        <SettingsRow
          title="Status"
          description={
            <span
              className={settings.status === "error" ? "text-destructive-foreground" : undefined}
            >
              {imessageStatusLabel(settings)}
            </span>
          }
          status={
            settings.lastDeliveryError ? (
              <span className="text-warning-foreground">
                {imessageDeliveryErrorLabel(settings.lastDeliveryError)}
              </span>
            ) : undefined
          }
        />
        <SettingsRow
          title="Use iMessage"
          description={hint ?? "Answer messages from the people listed below."}
          status={<FieldError message={switchError} />}
          control={
            <Switch
              aria-label="Use iMessage"
              checked={settings.enabled}
              disabled={!canAct || (hint !== null && !settings.enabled)}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
            />
          }
        />
        <ChannelLanguageRow environmentId={environmentId} disabled={!canAct} />
      </SettingsSection>

      <HandleSection
        title={`Chat with yourself${suffix}`}
        label="Your phone numbers and emails"
        description="Write to yourself in Messages; the assistant answers in the same chat, each reply starting with its name."
        emptyTitle="No numbers or emails yet"
        icon={<UserRoundIcon className={SECTION_ICON} />}
        handles={settings.selfHandles}
        suggestions={imessageSuggestedSelfHandles(ownHandles, settings)}
        canAct={canAct}
        save={(selfHandles) => settled({ selfHandles })}
      />

      <HandleSection
        title={`Other accounts${suffix}`}
        label="Allowed phone numbers and emails"
        description="If this Mac's Messages uses an Apple ID of its own, these people can message it."
        emptyTitle="No other accounts"
        icon={<AtSignIcon className={SECTION_ICON} />}
        handles={settings.allowedHandles}
        canAct={canAct}
        save={(allowedHandles) => settled({ allowedHandles })}
      />
    </>
  );
}

export function ImessageSettingsPanel() {
  const environmentIds = useImessageEnvironmentIds();
  const { environments } = useEnvironments();
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return (
    <SettingsPageContainer>
      {environmentIds.length === 0 ? (
        <SettingsSection title="iMessage" icon={<MessageCircleIcon className={SECTION_ICON} />}>
          <SettingsRow
            title="iMessage is not available"
            description="Connect to a Mac running T3 Code, then its iMessage settings appear here."
          />
        </SettingsSection>
      ) : (
        <>
          <p className="px-3 text-sm leading-normal text-muted-foreground sm:px-4">
            Talk to your assistants from Messages on this Mac. Start a message with @Name to pick an
            assistant; Jarvis answers otherwise, and the chat stays with the last assistant you
            picked. Send @ on its own to list your assistants. Works while T3 Code is running on
            this Mac.
          </p>
          {environmentIds.map((id, index) => (
            <ImessageEnvironment
              key={id}
              environmentId={id}
              suffix={environmentIds.length > 1 ? ` · ${labelOf(id)}` : ""}
              first={index === 0}
            />
          ))}
          <SettingsSection title="Good to know" icon={<InfoIcon className={SECTION_ICON} />}>
            <SettingsRow
              title="Approvals and limits"
              description="Approvals arrive as numbered choices: reply with the number. Group chats and attachments are not supported, and more than 10 messages a minute from one person are held back."
            />
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}
