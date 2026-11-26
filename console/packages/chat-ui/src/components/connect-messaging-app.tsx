import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ComponentType, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type {
  BridgeConfigField,
  ChatClaim,
  ClaimablePlatform,
  MessagingAppOffers,
  MessagingAppType,
} from '../contracts/switch-servers';
import { cn } from '../model/cn';
import {
  connectFormFields,
  connectionConfigFor,
  fieldDefaults,
  GUIDE_ASKED_FIELDS,
  GUIDE_FILLED_FIELDS,
  GUIDE_REQUIRED_FIELDS,
  type GuidedPlatform,
  isGuidedPlatform,
  isMissingRequired,
  missingFieldsMessage,
} from '../model/connect-messaging-app';
import { Button } from '../primitives/button';
import { Checkbox } from '../primitives/checkbox';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '../primitives/dialog';
import { DisclosureRow } from '../primitives/disclosure-row';
import { Field, FieldLabel } from '../primitives/field';
import { Input } from '../primitives/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../primitives/select';
import type { CreateRoomQuery } from './create-room-options';
import type { BridgeIcons } from './messaging-app-selector';

/** How often to look for the new connection while the person is on the platform's page. */
export const INSTALL_POLL_INTERVAL_MS = 3000;

/** A connection as the dialog watches for one. */
export type MessagingAppBridge = { id: string; type: string; displayName: string };

/** The app just connected. `directorySearchSupported` says whether linking an account on it can be offered. */
export type ConnectedMessagingApp = {
  bridgeId: string;
  displayName: string;
  directorySearchSupported: boolean;
};

export type NewMessagingApp = {
  bridgeType: string;
  displayName: string;
  connectionConfig: Record<string, string | boolean>;
  setAsDefault: boolean;
  channelCreationEnabled: boolean;
};

/** A connection made, or the server's refusal in words the person can act on. */
export type MessagingAppCreated =
  | {
      kind: 'created';
      bridge: { id: string; displayName: string; receivesWebhooks: boolean; webhookUrl: string | null };
    }
  | { kind: 'refused'; message: string };

/**
 * How the app names Switch and what is added to it, since the dashboard and
 * Console call them differently: "this server" and "connection" in Console,
 * "Switch" and "messaging app" on the web.
 */
export type MessagingAppWords = {
  /** "this server": who can add an app, and where Teams would send its messages. */
  thisServer: string;
  /** "this Switch server’s", in "Adds this Switch server’s own Slack app". */
  thisSwitchServers: string;
  /** "your server’s", in "sends every message to your server’s own address". */
  yourServers: string;
  /** "the server’s current default", what a new default replaces. */
  currentDefault: string;
  /** "on the server", where MESSAGING_PUBLIC_URL is set. */
  onTheServer: string;
  /** "connection": one messaging app added. */
  connection: string;
  /** "Switch Console", where a room's messaging app is picked. */
  appName: string;
};

function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type OwnAppGuideProps = {
  platform: GuidedPlatform;
  config: Record<string, string | boolean>;
  fields: readonly BridgeConfigField[];
  setField: (key: string, value: string | null) => void;
  setInput: (key: string, value: string | null) => void;
};

/**
 * What the app showing the dialog provides: who is connecting what, how it
 * reaches the server, opens pages and reads failures, and the pieces of its
 * own UI the dialog draws.
 */
export type ConnectMessagingAppHost = {
  /** Keeps one workspace's lookups apart from another's. */
  scope: string;
  words: MessagingAppWords;
  /** Named in the title; null when there is none to name. */
  serverName: string | null;
  /** Whether there is a workspace to connect to at all. */
  hasWorkspace: boolean;
  isAdmin: boolean;
  /** Why connecting cannot work here, said first; null when it can. */
  blocker: string | null;
  types: CreateRoomQuery<MessagingAppType[]>;
  /** Asked only of an admin; left idle for anyone else. */
  offers: CreateRoomQuery<MessagingAppOffers>;
  /** Whether Microsoft could not reach this server, so Teams would receive nothing. */
  teamsUnreachable: boolean;
  platformLabel: (platform: string) => string;
  docsUrl: (platform: string) => string;
  icons: BridgeIcons;
  openExternal: (url: string, failureTitle: string) => Promise<boolean>;
  /**
   * Opening a page whose address is only known after the server answers: the
   * returned `open` goes there, or answers false where it could not. Called at
   * the click, so a browser can open its tab before anything is awaited.
   */
  openWhenReady: (failureTitle: string) => {
    open: (url: string) => Promise<boolean>;
    cancel: () => void;
  };
  describeError: (error: unknown, fallback: string) => string;
  listBridges: () => Promise<MessagingAppBridge[]>;
  beginInstall: (platform: string) => Promise<string>;
  /**
   * The server's own app finished installing in the browser, seen as its new
   * connection: the first sign of it, for the app's usage report.
   */
  appInstalled: (bridgeId: string) => void;
  beginChatClaim: (platform: string) => Promise<ChatClaim>;
  createBridge: (app: NewMessagingApp) => Promise<MessagingAppCreated>;
  /** Keeps the dialog open while a connect is under way. */
  setCloseGuard: (active: boolean) => void;
  renderOwnAppGuide: (props: OwnAppGuideProps) => ReactNode;
  renderWebhookStep: (props: { platform: string; webhookUrl: string | null }) => ReactNode;
  ConfirmButton: ComponentType<{ onClick: () => void; disabled: boolean; children: ReactNode }>;
};

/**
 * Connecting a messaging app. Where the server has its own app for a platform
 * the dialog leads with adding it in one click, with the token form one link
 * away; a claim-based app shows its link and code; otherwise the form, with
 * Slack's setup walked through step by step.
 */
export const ConnectMessagingAppDialog = observer(function ConnectMessagingAppDialog({
  host,
  platform,
  onConnected,
  onClose,
}: {
  host: ConnectMessagingAppHost;
  /** Only this platform, chosen before the dialog opened. */
  platform?: string;
  onConnected: (app: ConnectedMessagingApp) => void;
  onClose: () => void;
}) {
  const { isAdmin, hasWorkspace, platformLabel, setCloseGuard, ConfirmButton, icons, words } =
    host;
  // Ties each label to its input, so a screen reader names the field.
  const idPrefix = useId();
  const inputId = (key: string) => `${idPrefix}-${key}`;

  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  // Credential values. Never persisted: this state dies with the dialog, and
  // the only thing that reads it is the submit call.
  const [config, setConfig] = useState<Record<string, string | boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(false);
  // Defaults on: most platforms can create channels, and the server rejects
  // this staying true for one that can't rather than us guessing wrong.
  const [channelCreationEnabled, setChannelCreationEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set once a webhook platform is connected: the dialog stays open on its
  // address, since the platform needs it before anything arrives.
  const [awaitingWebhookSetup, setAwaitingWebhookSetup] = useState<{
    app: ConnectedMessagingApp;
    platform: string;
    webhookUrl: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typesQuery = host.types;
  const installableQuery = host.offers;
  const installable = (installableQuery.data?.installable ?? []).filter(
    (p) => platform === undefined || p === platform
  );
  const claimable = (installableQuery.data?.claimable ?? []).filter(
    (c) => c.canAddChat && (platform === undefined || c.platform === platform)
  );
  const [useOwnApp, setUseOwnApp] = useState(false);
  // The platform whose link and code are on screen. From then on the dialog is
  // about that one chat.
  const [claimingPlatform, setClaimingPlatform] = useState<string | null>(null);
  const offerInstall = (installable.length > 0 || claimable.length > 0) && !useOwnApp;
  const showForm = !offerInstall && !(isAdmin && installableQuery.isLoading);

  const types = useMemo(() => typesQuery.data ?? [], [typesQuery.data]);
  const selectedType = types.find((t) => t.key === typeKey) ?? null;
  const guided = isGuidedPlatform(selectedType?.key) && hasWorkspace;
  // The guide asks for its tokens as required, whatever the schema says.
  const formFields = connectFormFields(
    selectedType?.key ?? '',
    selectedType?.fields ?? [],
    isGuidedPlatform(selectedType?.key) ? GUIDE_REQUIRED_FIELDS[selectedType.key] : []
  );
  // What the guide fills in or asks for itself is not asked for again below it.
  const guideFields = isGuidedPlatform(selectedType?.key)
    ? [...GUIDE_FILLED_FIELDS[selectedType.key], ...GUIDE_ASKED_FIELDS[selectedType.key]]
    : [];
  const visibleFields = formFields.filter((field) => !guideFields.includes(field.key));
  const setGuideField = useCallback((key: string, value: string | null) => {
    setConfig((prev) => {
      if ((prev[key] ?? null) === value) return prev;
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);
  // A token typed into the guide is the person editing the form: the last error no longer applies.
  const setGuideInput = useCallback(
    (key: string, value: string | null) => {
      setGuideField(key, value);
      setError(null);
    },
    [setGuideField]
  );
  // Unknown until the type list has loaded; assume supported so the checkbox
  // isn't forced off while that request is in flight.
  const channelCreationSupported = selectedType?.channelCreationSupported ?? true;

  const handleTypeChange = useCallback(
    (next: string | null) => {
      // Switching platform drops whatever was typed for the previous one, so a
      // stale token is never submitted, and seeds the new one's defaults.
      const prevLabel = typeKey ? platformLabel(typeKey) : null;
      const nextLabel = next ? platformLabel(next) : '';
      if (!displayName.trim() || displayName === prevLabel) {
        setDisplayName(nextLabel);
      }
      setTypeKey(next);
      setConfig(fieldDefaults(types.find((t) => t.key === next)?.fields ?? []));
      setChannelCreationEnabled(true);
      setError(null);
    },
    [types, typeKey, displayName, platformLabel]
  );

  useEffect(() => {
    if (platform !== undefined && typeKey === null && types.some((t) => t.key === platform))
      handleTypeChange(platform);
  }, [platform, typeKey, types, handleTypeChange]);

  const trimmedName = displayName.trim();
  const missingRequired = formFields.some((field) => isMissingRequired(field, config));
  // Only what the person can type is named: a field the guide fills in itself is reported by the guide.
  const missingMessage = missingFieldsMessage(
    formFields.filter(
      (field) =>
        !isGuidedPlatform(selectedType?.key) ||
        !GUIDE_FILLED_FIELDS[selectedType.key].includes(field.key)
    ),
    config
  );
  const canSubmit =
    showForm &&
    hasWorkspace &&
    isAdmin &&
    !!selectedType &&
    !!trimmedName &&
    !missingRequired &&
    !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedType) return;
    setIsSubmitting(true);
    setCloseGuard(true);
    setError(null);

    try {
      const result = await host.createBridge({
        bridgeType: selectedType.key,
        displayName: trimmedName,
        connectionConfig: connectionConfigFor(selectedType.fields, config),
        setAsDefault,
        // Forced off for a platform that can't create channels, whatever the checkbox says.
        channelCreationEnabled: channelCreationSupported && channelCreationEnabled,
      });

      if (result.kind !== 'created') {
        setError(result.message);
        return;
      }
      const app = {
        bridgeId: result.bridge.id,
        displayName: result.bridge.displayName,
        directorySearchSupported: selectedType.directorySearchSupported,
      };
      if (result.bridge.receivesWebhooks) {
        setAwaitingWebhookSetup({
          app,
          platform: selectedType.key,
          webhookUrl: result.bridge.webhookUrl,
        });
        return;
      }
      onConnected(app);
    } catch (cause) {
      setError(host.describeError(cause, 'Could not connect the messaging app.'));
    } finally {
      setIsSubmitting(false);
      setCloseGuard(false);
    }
  }, [
    canSubmit,
    selectedType,
    host,
    trimmedName,
    config,
    setAsDefault,
    channelCreationSupported,
    channelCreationEnabled,
    onConnected,
    setCloseGuard,
  ]);

  const handleInstalled = useCallback(
    (platform: string, bridge: { bridgeId: string; displayName: string }) => {
      onConnected({
        ...bridge,
        // Unknown only if the type list failed to load; offering the link step
        // then costs a search that finds nothing, where skipping it would hide
        // a step that works.
        directorySearchSupported:
          types.find((t) => t.key === platform)?.directorySearchSupported ?? true,
      });
    },
    [onConnected, types]
  );

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>
          {claimingPlatform !== null
            ? `Add to ${platformLabel(claimingPlatform)}`
            : `Connect a messaging app${host.serverName ? ` to ${host.serverName}` : ''}`}
        </DialogTitle>
      </DialogHeader>
      {awaitingWebhookSetup !== null ? (
        <>
          <DialogContentArea className="pt-0">
            {host.renderWebhookStep({
              platform: awaitingWebhookSetup.platform,
              webhookUrl: awaitingWebhookSetup.webhookUrl,
            })}
          </DialogContentArea>
          <DialogFooter>
            <ConfirmButton onClick={() => onConnected(awaitingWebhookSetup.app)} disabled={false}>
              Done
            </ConfirmButton>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogContentArea className="pt-0">
            <div className="flex w-full flex-col gap-5">
              {host.blocker && <p className="text-xs text-destructive">{host.blocker}</p>}

              {installableQuery.isError && (
                <p className="text-xs text-destructive">
                  {host.describeError(
                    installableQuery.error,
                    `Could not check which messaging apps ${words.thisServer} can add for you, so only connecting your own app is offered.`
                  )}
                </p>
              )}

              {isAdmin && installableQuery.isLoading && (
                <p className="text-xs text-foreground-muted">Loading…</p>
              )}

              {offerInstall && hasWorkspace && (
                <>
                  {claimingPlatform === null &&
                    installable.map((platform) => (
                      <InstallAppPanel
                        key={platform}
                        host={host}
                        platform={platform}
                        onInstalled={(bridge) => handleInstalled(platform, bridge)}
                      />
                    ))}
                  {claimable
                    .filter((c) => claimingPlatform === null || c.platform === claimingPlatform)
                    .map((c) => (
                      <ConnectChatPanel
                        key={c.platform}
                        host={host}
                        claimable={c}
                        onShown={() => setClaimingPlatform(c.platform)}
                        onConnected={(bridge) => handleInstalled(c.platform, bridge)}
                      />
                    ))}
                  {claimingPlatform === null && (
                    <button
                      type="button"
                      className="w-fit text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
                      onClick={() => setUseOwnApp(true)}
                    >
                      Use your own app instead
                    </button>
                  )}
                </>
              )}

              {showForm && (
                <Field>
                  <FieldLabel htmlFor={inputId('platform')}>Messaging app</FieldLabel>
                  <Select
                    value={typeKey ?? ''}
                    onValueChange={(next) => handleTypeChange(next ?? null)}
                    disabled={typesQuery.isLoading || types.length === 0 || !isAdmin}
                  >
                    <SelectTrigger id={inputId('platform')}>
                      <SelectValue
                        placeholder={typesQuery.isLoading ? 'Loading…' : 'Choose a platform'}
                      >
                        {selectedType ? platformLabel(selectedType.key) : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {types.map((type) => (
                        <SelectItem key={type.key} value={type.key}>
                          <span className="flex items-center gap-2">
                            {icons.hasBridgeIcon(type.key) && (
                              <icons.BridgeIcon bridgeType={type.key} size={16} />
                            )}
                            {platformLabel(type.key)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {typesQuery.isError && (
                    <p className="mt-1 text-xs text-destructive">
                      {host.describeError(
                        typesQuery.error,
                        'Could not load the available messaging apps.'
                      )}
                    </p>
                  )}
                </Field>
              )}

              {showForm && selectedType && (
                <>
                  {selectedType.key === 'teams' && host.teamsUnreachable && (
                    <div
                      role="note"
                      className="rounded-md border border-border bg-background-1 px-3 py-2 text-xs text-foreground"
                    >
                      Microsoft Teams sends every message to {words.yourServers} own address, so it
                      needs a public HTTPS address that Microsoft can reach.{' '}
                      {capitalized(words.thisServer)} runs on your computer or a private network, so
                      Teams messages would not arrive. Run Switch somewhere public first; the{' '}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() =>
                          void host.openExternal(
                            host.docsUrl('teams'),
                            'Could not open the setup guide'
                          )
                        }
                      >
                        Teams setup guide
                      </button>{' '}
                      explains what it needs.
                    </div>
                  )}

                  {selectedType.key === 'telegram' && (
                    <div
                      role="note"
                      className="rounded-md border border-border bg-background-1 px-3 py-2 text-xs text-foreground"
                    >
                      <p>
                        Before you add the bot to a group, turn off its Group Privacy: in BotFather,
                        send <code>/setprivacy</code>, pick the bot and choose{' '}
                        <span className="font-medium">Disable</span>. Otherwise it sees only
                        commands and replies to its own messages. Already in a group? Remove it and
                        add it back, or make it an admin.
                      </p>
                      <p className="mt-1">
                        Then, in a group with the bot, link your Telegram account first, and bring
                        agents in with <code>/invite_agent</code> after.
                      </p>
                    </div>
                  )}

                  <Field>
                    <FieldLabel htmlFor={inputId('display-name')}>Name</FieldLabel>
                    <Input
                      id={inputId('display-name')}
                      placeholder={`e.g. ${platformLabel(selectedType.key)}`}
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        setError(null);
                      }}
                    />
                    <p className="mt-1 text-xs text-foreground-muted">
                      How this {words.connection} is labelled in {words.appName} when you pick it
                      for a room.
                    </p>
                  </Field>

                  {guided &&
                    isGuidedPlatform(selectedType.key) &&
                    host.renderOwnAppGuide({
                      platform: selectedType.key,
                      config,
                      fields: formFields,
                      setField: setGuideField,
                      setInput: setGuideInput,
                    })}

                  {/* What a "bot token" is, and where to get one, lives in the
                  platform's setup guide: linked where the question arises. The
                  guided setup carries its own link. */}
                  {!guided && (
                    <button
                      type="button"
                      className="flex w-fit items-center gap-1 text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
                      onClick={() =>
                        void host.openExternal(
                          host.docsUrl(selectedType.key),
                          'Could not open the setup guide'
                        )
                      }
                    >
                      How to set up {platformLabel(selectedType.key)}
                      <ExternalLink className="size-3" />
                    </button>
                  )}

                  {visibleFields
                    .filter((field) => field.kind !== 'boolean')
                    .map((field, index) => (
                      <Field key={`${selectedType.key}:${field.key}`}>
                        <FieldLabel htmlFor={inputId(field.key)}>
                          {field.label}
                          {!field.required && (
                            <span className="ml-1 font-normal text-foreground-muted">
                              (optional)
                            </span>
                          )}
                        </FieldLabel>
                        <Input
                          id={inputId(field.key)}
                          // The guided setup asks its own questions first; focus stays with it.
                          autoFocus={index === 0 && !guided}
                          // Masked for credentials, so a token is not left readable on
                          // screen while the user checks the rest of the form.
                          type={field.secret ? 'password' : 'text'}
                          autoComplete={field.secret ? 'new-password' : 'off'}
                          spellCheck={false}
                          value={
                            typeof config[field.key] === 'string'
                              ? (config[field.key] as string)
                              : ''
                          }
                          onChange={(e) => {
                            const { value } = e.target;
                            setConfig((prev) => ({ ...prev, [field.key]: value }));
                            setError(null);
                          }}
                        />
                        {field.description && (
                          <p className="mt-1 text-xs text-foreground-muted">{field.description}</p>
                        )}
                      </Field>
                    ))}

                  <DisclosureRow
                    open={advancedOpen}
                    title="Advanced configuration"
                    onToggle={() => setAdvancedOpen((open) => !open)}
                  />
                  {advancedOpen && (
                    <div className="flex flex-col gap-4">
                      {visibleFields
                        .filter((field) => field.kind === 'boolean')
                        .map((field) => (
                          <label
                            key={field.key}
                            className="group/field flex cursor-pointer items-start gap-2.5"
                          >
                            <Checkbox
                              checked={config[field.key] === true}
                              onCheckedChange={(checked) => {
                                setConfig((prev) => ({ ...prev, [field.key]: checked === true }));
                                setError(null);
                              }}
                              className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                              <span className="text-sm font-medium">{field.label}</span>
                              {field.description && (
                                <span className="text-xs text-foreground-muted">
                                  {field.description}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}

                      <label
                        className={cn(
                          'group/field flex items-start gap-2.5',
                          channelCreationSupported ? 'cursor-pointer' : 'cursor-not-allowed'
                        )}
                      >
                        <Checkbox
                          checked={channelCreationSupported && channelCreationEnabled}
                          disabled={!channelCreationSupported}
                          onCheckedChange={(checked) => setChannelCreationEnabled(checked === true)}
                          className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">
                            Allow creating channels from Switch
                          </span>
                          <span className="text-xs text-foreground-muted">
                            {channelCreationSupported
                              ? `Allows Switch users and agents to create channels in ${platformLabel(selectedType.key)} from Switch. Turn it off to only ever use channels made in the app.`
                              : `${platformLabel(selectedType.key)} has no way to create channels from Switch, so this ${words.connection} can only be used with channels made in the app.`}
                          </span>
                        </span>
                      </label>

                      <label className="group/field flex cursor-pointer items-start gap-2.5">
                        <Checkbox
                          checked={setAsDefault}
                          onCheckedChange={(checked) => setSetAsDefault(checked === true)}
                          className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">Use for new rooms by default</span>
                          <span className="text-xs text-foreground-muted">
                            Rooms created without naming a messaging app will land here. Replaces{' '}
                            {words.currentDefault}; existing rooms are unaffected.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </>
              )}

              {showForm && selectedType && missingMessage && (
                <p className="text-xs text-foreground-muted">{missingMessage}</p>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </DialogContentArea>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              {claimingPlatform !== null ? 'Close' : 'Cancel'}
            </Button>
            {showForm && (
              <ConfirmButton onClick={() => void handleSubmit()} disabled={!canSubmit}>
                {isSubmitting ? 'Connecting…' : 'Connect'}
              </ConfirmButton>
            )}
          </DialogFooter>
        </>
      )}
    </>
  );
});

type InstalledBridge = { bridgeId: string; displayName: string };

type InstallPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; knownBridgeIds: ReadonlySet<string>; authorizeUrl: string };

/**
 * Adds the server's own app for `platform` to the workspace. The platform's
 * consent screen runs outside the dialog and the server finishes the install
 * on its public callback, so the only sign it worked is a new connection of
 * that platform: the panel notes which existed before and watches for one it
 * has not seen.
 */
function InstallAppPanel({
  host,
  platform,
  onInstalled,
}: {
  host: ConnectMessagingAppHost;
  platform: string;
  onInstalled: (bridge: InstalledBridge) => void;
}) {
  const label = host.platformLabel(platform);
  const [phase, setPhase] = useState<InstallPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const waiting = phase.kind === 'waiting';
  const bridgesQuery = useQuery({
    queryKey: ['messaging-app-install-wait', host.scope, platform],
    queryFn: host.listBridges,
    enabled: waiting,
    refetchInterval: waiting ? INSTALL_POLL_INTERVAL_MS : false,
    gcTime: 0,
  });

  useEffect(() => {
    if (phase.kind !== 'waiting' || !bridgesQuery.data) return;
    const installed = bridgesQuery.data.find(
      (b) => b.type === platform && !phase.knownBridgeIds.has(b.id)
    );
    if (!installed) return;
    host.appInstalled(installed.id);
    onInstalled({ bridgeId: installed.id, displayName: installed.displayName });
  }, [phase, bridgesQuery.data, platform, onInstalled, host]);

  const start = async () => {
    const page = host.openWhenReady(`Could not open ${label}`);
    setPhase({ kind: 'starting' });
    setError(null);
    try {
      const before = await host.listBridges();
      const authorizeUrl = await host.beginInstall(platform);
      if (!(await page.open(authorizeUrl))) {
        setPhase({ kind: 'idle' });
        return;
      }
      setPhase({ kind: 'waiting', knownBridgeIds: new Set(before.map((b) => b.id)), authorizeUrl });
    } catch (cause) {
      page.cancel();
      setPhase({ kind: 'idle' });
      setError(host.describeError(cause, `Could not start adding ${label}.`));
    }
  };

  if (phase.kind === 'waiting') {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          Waiting for {label}…
        </p>
        <p className="text-xs text-foreground-muted">
          Approve the Switch app in the browser window that opened. This {host.words.connection}{' '}
          appears here as soon as {label} confirms it.
        </p>
        <button
          type="button"
          className="w-fit text-xs text-foreground-muted underline underline-offset-2 hover:text-foreground"
          onClick={() => void host.openExternal(phase.authorizeUrl, `Could not open ${label}`)}
        >
          Open the {label} page again
        </button>
        {bridgesQuery.isError && (
          <p className="text-xs text-destructive">
            {host.describeError(
              bridgesQuery.error,
              `Could not check whether ${label} is connected yet; still trying`
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-muted">
        Adds {host.words.thisSwitchServers} own {label} app to your {label} workspace. {label} asks
        you to approve it in your browser; there are no tokens to copy.
      </p>
      <Button className="w-fit" onClick={() => void start()} disabled={phase.kind === 'starting'}>
        {host.icons.hasBridgeIcon(platform) && (
          <host.icons.BridgeIcon bridgeType={platform} size={16} />
        )}
        {phase.kind === 'starting' ? `Opening ${label}…` : `Add to ${label}`}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

type ClaimPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'shown'; claim: ChatClaim; knownBridgeIds: ReadonlySet<string> | null };

/**
 * Connects a chat to the server's claim-based app for a platform (the Switch
 * Telegram app). The claim lands in the chat, so nothing comes back when it
 * works, except for a workspace's first chat, which creates the connection:
 * the panel watches for that one as an install does.
 */
function ConnectChatPanel({
  host,
  claimable,
  onShown,
  onConnected,
}: {
  host: ConnectMessagingAppHost;
  claimable: ClaimablePlatform;
  /** Called once the link and code are on screen. */
  onShown: () => void;
  /** Called once the workspace's first chat has created its connection. */
  onConnected: (bridge: InstalledBridge) => void;
}) {
  const { platform } = claimable;
  const label = host.platformLabel(platform);
  const [phase, setPhase] = useState<ClaimPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const watching = phase.kind === 'shown' && phase.knownBridgeIds !== null;
  const bridgesQuery = useQuery({
    queryKey: ['messaging-app-claim-wait', host.scope, platform],
    queryFn: host.listBridges,
    enabled: watching,
    refetchInterval: watching ? INSTALL_POLL_INTERVAL_MS : false,
    gcTime: 0,
  });

  useEffect(() => {
    if (phase.kind !== 'shown' || phase.knownBridgeIds === null || !bridgesQuery.data) return;
    const known = phase.knownBridgeIds;
    const created = bridgesQuery.data.find((b) => b.type === platform && !known.has(b.id));
    if (created) onConnected({ bridgeId: created.id, displayName: created.displayName });
  }, [phase, bridgesQuery.data, platform, onConnected]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    setError(null);
    try {
      const before = claimable.connected ? null : await host.listBridges();
      const claim = await host.beginChatClaim(platform);
      setPhase({
        kind: 'shown',
        claim,
        knownBridgeIds: before === null ? null : new Set(before.map((b) => b.id)),
      });
      onShown();
    } catch (cause) {
      setPhase({ kind: 'idle' });
      setError(host.describeError(cause, `Could not start connecting a ${label} chat.`));
    }
  };

  if (phase.kind === 'shown') {
    return (
      <div className="flex flex-col gap-2">
        <ChatClaimDetails label={label} claim={phase.claim} openExternal={host.openExternal} />
        {watching && (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Loader2 className="size-3.5 animate-spin" />
            This {host.words.connection} appears here as soon as the first chat is connected.
          </p>
        )}
        {watching && bridgesQuery.isError && (
          <p className="text-xs text-destructive">
            {host.describeError(
              bridgesQuery.error,
              `Could not check whether ${label} is connected yet; still trying`
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-foreground-muted">
        Connects a {label} group or channel to {host.words.thisSwitchServers} own {label} app. Each
        chat gets a room; there are no tokens to copy.
      </p>
      <Button className="w-fit" onClick={() => void start()} disabled={phase.kind === 'starting'}>
        {host.icons.hasBridgeIcon(platform) && (
          <host.icons.BridgeIcon bridgeType={platform} size={16} />
        )}
        {phase.kind === 'starting' ? 'Getting a link…' : `Add to ${label}`}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * How to use a claim: a link for a group, and the bot's handle and a command
 * for a channel. A channel carries nothing when a bot is added to it, so its
 * admin adds the bot by hand and posts the code; the handle is shown whole
 * because Telegram's search does not find a bot by part of it. The expiry is
 * said here because a link that quietly stopped working looks exactly like one
 * that never did.
 */
export function ChatClaimDetails({
  label,
  claim,
  openExternal,
}: {
  label: string;
  claim: ChatClaim;
  openExternal: (url: string, failureTitle: string) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Button
          className="w-fit"
          onClick={() => void openExternal(claim.url, `Could not open ${label}`)}
        >
          <ExternalLink className="size-4" />
          Add to a {label} group
        </Button>
        <p className="text-xs text-foreground-muted">
          Pick a group and confirm. The bot joins and asks which Switch organisation the group is
          for; when a group admin chooses Connect, Switch creates the group’s room.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 text-xs">
        <p>
          For a channel, open its Administrators, choose Add Admin, and search for the bot by its
          full username:
        </p>
        <CopyableValue value={claim.botHandle} label="the bot’s username" />
        <p>
          Keep its permission to post, save, then post this in the channel and choose Connect when
          the bot asks:
        </p>
        <CopyableValue value={`/connect ${claim.code}`} label="the command" />
        <p className="text-foreground-muted">
          Agents can always post to the channel. For posts in the channel to reach agents, turn on
          Sign Messages and Show Authors’ Profiles in its settings, and post as yourself rather than
          as the channel.
        </p>
      </div>

      <p className="rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
        The link and the code work once, for ten minutes. Anyone who has them in that time can ask
        to connect a chat to this workspace, so share them only with people who should.
      </p>
    </div>
  );
}

function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 truncate rounded bg-background-quaternary-1 px-2 py-1 font-mono text-xs text-foreground">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        className="shrink-0 rounded p-1 text-foreground-passive hover:bg-background-2 hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5 text-foreground-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/**
 * Shown straight after connecting a platform that delivers its events to an
 * address of the connection's own. Nothing arrives until someone gives the
 * platform that address, so this is the moment to hand it over — not a menu
 * they would have to know to look in afterwards.
 */
export function WebhookAddressStep({
  label,
  webhookUrl,
  words,
}: {
  label: string;
  webhookUrl: string | null;
  words: Pick<MessagingAppWords, 'thisServer' | 'onTheServer' | 'connection'>;
}) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  if (webhookUrl === null) {
    return (
      <p className="text-xs text-destructive">
        {label} is connected, but it delivers events to a public address and {words.thisServer} has
        none configured, so no message from {label} can reach Switch yet. Set MESSAGING_PUBLIC_URL{' '}
        {words.onTheServer}; the address then appears in this {words.connection}&apos;s menu.
      </p>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {label} is connected. Give {label} this address so its messages reach Switch — the
        platform&apos;s setup guide says where it goes.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={webhookUrl} spellCheck={false} className="font-mono text-xs" />
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <Copy className="size-3" />
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {copied === 'failed' && (
        <p className="text-xs text-destructive">Could not copy it; select the address instead.</p>
      )}
      <p className="text-xs text-foreground-muted">
        You can copy it again later from this {words.connection}&apos;s menu.
      </p>
    </div>
  );
}
