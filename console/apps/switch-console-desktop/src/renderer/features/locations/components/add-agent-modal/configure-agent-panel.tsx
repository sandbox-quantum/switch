import { useQuery } from '@tanstack/react-query';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  PERMISSION_COPY,
  UnsafeBadge,
} from '@renderer/features/locations/components/settings-view/sections/permission-settings-section';
import { MID_TURN_DELIVERY_COPY } from '@renderer/features/locations/components/settings-view/sections/mid-turn-delivery-settings-section';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { AddressingPolicyControl } from '@renderer/features/switch-servers/addressing-policy-control';
import type { OptionItem } from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { policyNamesOwner } from '@shared/core/switch-servers/owner-policy';
import type { ConfigureAgentFormState } from './modes';

/**
 * Create form for a new Switch agent in a directory. Collects the target server,
 * Switch agent name, and description, then the managed-session options
 * (auto mode, bypass permissions, addressing policy). Switch Console always
 * registers the agent as a managed, session-addressable identity — there is no
 * run-mode or notify-handle choice (CHOO-1440); advanced definition attributes
 * live in the collapsed Advanced section.
 */
export const AgentSettingsSection = observer(function AgentSettingsSection({
  form,
  workspaceId,
  onAddServer,
  onOpenMessagingApps,
  children,
}: {
  form: ConfigureAgentFormState;
  workspaceId: string | null;
  onAddServer: () => void;
  onOpenMessagingApps: () => void;
  /** Further settings for this kind of agent, after the common ones. */
  children: ReactNode;
}) {
  // Sessions, permissions and addressing are set once and rarely revisited, so
  // they start folded — the identity fields above are what the dialog is for.
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (switchServersStore.servers.length === 0) void switchServersStore.init();
  }, []);

  const servers = switchServersStore.servers;

  // Selector data for the addressing-policy editor, scoped to the workspace the
  // chosen server is in scope for.
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', workspaceId],
    queryFn: () => rpc.workspaces.listRooms(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const groupsQuery = useQuery({
    queryKey: ['remote-room-groups', workspaceId],
    queryFn: () => rpc.workspaces.listRoomGroups(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const usersQuery = useQuery({
    queryKey: ['remote-external-users', workspaceId],
    queryFn: () => rpc.workspaces.listExternalUsers(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const agentsQuery = useWorkspaceAgents(workspaceId);
  const roomOptions: OptionItem[] = (roomsQuery.data ?? []).map((r) => ({
    id: r.id,
    label: r.name,
  }));
  const groupOptions: OptionItem[] = (groupsQuery.data ?? []).map((g) => ({
    id: g.id,
    label: g.name,
  }));
  const userOptions: OptionItem[] = (usersQuery.data ?? []).map((u) => ({
    id: u.id,
    label: u.username,
  }));
  const agentOptions: OptionItem[] = (agentsQuery.data ?? []).map((a) => ({
    id: a.id,
    label: a.name,
  }));

  // Read here rather than inside the editor so the owner-only default can be
  // questioned before the agent exists, not after it has gone quiet.
  const { identities } = useMyIdentities(workspaceId);
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  const unlinkedApps =
    identities === null || bridgesQuery.data === undefined
      ? null
      : bridgesQuery.data
          .filter((bridge) => !identities.some((identity) => identity.bridgeId === bridge.id))
          .map((bridge) => bridge.displayName);

  // The same condition the control draws its warning from, so the section opens
  // exactly when there is a warning inside it and never on a hunch of its own.
  const ownerUnreachable =
    policyNamesOwner(form.addressingPolicy) && unlinkedApps !== null && unlinkedApps.length > 0;

  // Folded is right until the defaults are wrong. The default policy admits no
  // person in an app with no account linked, and a warning nothing on screen
  // hints at is a warning nobody reads — so the section opens itself the first
  // time that is true. Once only: closing it again is an answer, not an
  // oversight, and the queries behind `unlinkedApps` settle after mount.
  const openedForWarning = useRef(false);
  useEffect(() => {
    if (!ownerUnreachable || openedForWarning.current) return;
    openedForWarning.current = true;
    setSettingsOpen(true);
  }, [ownerUnreachable]);

  if (servers.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs text-foreground-muted">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span>
            No Switch servers are registered yet. Add the server to register this agent on.
          </span>
          <Button variant="outline" size="sm" className="self-start" onClick={onAddServer}>
            Add a server
          </Button>
        </div>
      </div>
    );
  }

  return (
    <FieldGroup>
      {/* No box around the disclosure: it is a heading for the fields it
          reveals, and framing it made it read as a control of the same weight
          as the inputs above and below it. */}
      <div>
        <DisclosureRow
          open={settingsOpen}
          title="Settings"
          meta="Sessions, permissions, who can address it"
          onToggle={() => setSettingsOpen((v) => !v)}
        />
        {settingsOpen && (
          <FieldGroup className="pt-3">
            <PermissionToggle
              setting="autoMode"
              description={
                form.autoApprove
                  ? `${PERMISSION_COPY.autoMode.description} ${PERMISSION_COPY.autoMode.overridden}`
                  : PERMISSION_COPY.autoMode.description
              }
              checked={form.autoMode}
              onCheckedChange={form.setAutoMode}
            />
            <PermissionToggle
              setting="autoApprove"
              description={PERMISSION_COPY.autoApprove.description}
              checked={form.autoApprove}
              onCheckedChange={form.setAutoApprove}
            />

            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldTitle>
                  <span className="flex items-center gap-1.5">
                    {MID_TURN_DELIVERY_COPY.title}
                    <InfoTooltip
                      label={MID_TURN_DELIVERY_COPY.infoLabel}
                      content={MID_TURN_DELIVERY_COPY.info}
                    />
                  </span>
                </FieldTitle>
                <Select
                  value={form.midTurnDelivery}
                  onValueChange={(val) => form.setMidTurnDelivery(val as 'steer' | 'queue')}
                >
                  <SelectTrigger className="w-60" aria-label="Mid-turn message handling">
                    <SelectValue>{MID_TURN_DELIVERY_COPY.options[form.midTurnDelivery]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="steer">
                      {MID_TURN_DELIVERY_COPY.options.steer}
                    </SelectItem>
                    <SelectItem value="queue">
                      {MID_TURN_DELIVERY_COPY.options.queue}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <FieldDescription className="text-foreground-muted">
                {MID_TURN_DELIVERY_COPY.description}
              </FieldDescription>
            </Field>

            <Field>
              {/* FieldTitle rather than FieldLabel: this is a settings row like
                  the two toggles above it, and the label styling set it lighter
                  and greyer than them for no reason the reader can see. */}
              <FieldTitle>
                <span className="flex items-center gap-1.5">
                  Who can talk to your agent
                  <InfoTooltip
                    label="More info about addressing"
                    content="Talking to an agent means an @mention or a targeted message. A new agent answers you and your own agents; choose Only me to shut your agents out, or let others in. You can change this later from the agent's settings."
                  />
                </span>
              </FieldTitle>
              <AddressingPolicyControl
                value={form.addressingPolicy}
                onChange={form.setAddressingPolicy}
                rooms={roomOptions}
                roomGroups={groupOptions}
                users={userOptions}
                agents={agentOptions}
                unlinkedApps={unlinkedApps}
                onOpenMessagingApps={onOpenMessagingApps}
                inlineLabel={null}
              />
            </Field>
            {children}
          </FieldGroup>
        )}
      </div>
    </FieldGroup>
  );
});

/**
 * Name and description, which are what the dialog is really asking for.
 *
 * Separate from the settings below because they need nothing but the form,
 * while the addressing control needs the server's rooms, groups, users and
 * agents — so the two halves can sit in different places in the dialog without
 * the identity fields waiting on four queries they do not use.
 */
export function AgentIdentityFields({
  form,
  serverId,
  nameTaken,
}: {
  form: ConfigureAgentFormState;
  /** The Switch server whose generated icons are offered. */
  serverId: string | null;
  /** Another agent on the server already has this name. */
  nameTaken: boolean;
}) {
  const nameId = useId();
  const descriptionId = useId();
  const instructionsId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <FieldGroup>
      {/* Above the name, because it is the first thing the finished agent is
          recognised by. */}
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <AgentIconPicker
          serverId={serverId}
          name={form.agentName}
          iconUrl={form.iconUrl}
          onChange={form.setIconUrl}
          size={84}
        />
        <span className="text-xs text-foreground-muted">
          {form.iconUrl === null && form.thirdPartyAvatarsEnabled === false
            ? 'No icon'
            : form.iconIsGenerated
              ? 'Automatically generated'
              : 'Custom icon'}
        </span>
      </div>

      <Field>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          ref={nameRef}
          placeholder="Name this agent"
          value={form.agentName}
          onChange={(e) => form.setAgentName(e.target.value)}
          aria-invalid={form.nameIsRejected || nameTaken}
        />
        {form.nameIsRejected ? (
          <Alert
            variant="destructive"
            className="border-border-destructive bg-background-destructive"
          >
            <TriangleAlert />
            <AlertDescription className="text-foreground-destructive">
              Use lowercase letters, digits, <span className="font-mono">. - _</span>, starting with
              a letter or digit. No spaces or uppercase.
            </AlertDescription>
            {form.suggestedName && (
              <AlertAction>
                <Button
                  variant="outline"
                  size="xs"
                  className="max-w-full"
                  // Accepting the offer makes the name valid, which unmounts this
                  // button; without moving focus first it falls to the body and
                  // the tab order restarts.
                  onClick={() => {
                    form.acceptSuggestedName();
                    nameRef.current?.focus();
                  }}
                >
                  Use <span className="truncate font-mono">{form.suggestedName}</span>
                </Button>
              </AlertAction>
            )}
          </Alert>
        ) : nameTaken ? (
          <Alert
            variant="destructive"
            className="border-border-destructive bg-background-destructive"
          >
            <TriangleAlert />
            <AlertDescription className="text-foreground-destructive">
              An agent called <span className="font-mono">{form.agentName}</span> already exists on
              this server. Pick another name.
            </AlertDescription>
          </Alert>
        ) : form.agentName.length > 0 ? (
          // Once there is a name, show the handle it produces rather than
          // repeating the advice: the advice is about choosing a name, and it
          // has been taken.
          <span className="text-xs text-foreground-muted">
            In rooms this agent is addressed as{' '}
            <span className="text-foreground">@{form.agentName}</span>.
          </span>
        ) : (
          <span className="text-xs text-foreground-muted">
            In rooms this agent is addressed by its name — include your own so it&apos;s clear whose
            agent it is.
          </span>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <Input
          id={descriptionId}
          placeholder="What is this agent for?"
          value={form.description}
          onChange={(e) => form.setDescription(e.target.value)}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor={instructionsId}>
          Agent instructions <span className="text-foreground-muted">(optional)</span>
        </FieldLabel>
        <Textarea
          id={instructionsId}
          rows={4}
          placeholder="How this agent should work"
          value={form.instructions}
          onChange={(e) => form.setInstructions(e.target.value)}
        />
      </Field>
    </FieldGroup>
  );
}

/** One permission setting of the create form: a whole-row label around its switch. */
function PermissionToggle({
  setting,
  description,
  checked,
  onCheckedChange,
}: {
  setting: keyof typeof PERMISSION_COPY;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const copy = PERMISSION_COPY[setting];
  return (
    <Field>
      <label className="-mx-2 flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--sel-soft)]">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm">
            {copy.title}
            {setting === 'autoApprove' && <UnsafeBadge />}
            <InfoTooltip label={copy.infoLabel} content={copy.info} />
          </span>
          <span className="text-xs text-foreground-muted">{description}</span>
        </span>
        <Switch
          className="mt-0.5"
          aria-label={copy.title}
          checked={checked}
          onCheckedChange={(next) => onCheckedChange(next)}
        />
      </label>
    </Field>
  );
}
