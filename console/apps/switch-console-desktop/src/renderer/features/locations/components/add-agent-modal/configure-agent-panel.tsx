import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useState } from 'react';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { AddressingPolicyControl } from '@renderer/features/switch-servers/addressing-policy-control';
import type { OptionItem } from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import type { ConfigureAgentFormState } from './modes';

/**
 * Create form for a new Switch agent in a directory. Collects the target server,
 * Switch agent name, and description, then the managed-session options
 * (auto-session, bypass permissions, addressing policy). Switch Console always
 * registers the agent as a managed, session-addressable identity — there is no
 * run-mode or notify-handle choice (CHOO-1440); advanced definition attributes
 * live in the collapsed Advanced section.
 */
export const AgentSettingsSection = observer(function AgentSettingsSection({
  form,
  serverId,
  onAddServer,
  onOpenMessagingApps,
}: {
  form: ConfigureAgentFormState;
  serverId: string | null;
  onAddServer: () => void;
  onOpenMessagingApps: () => void;
}) {
  // Sessions, permissions and addressing are set once and rarely revisited, so
  // they start folded — the identity fields above are what the dialog is for.
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (switchServersStore.servers.length === 0) void switchServersStore.init();
  }, []);

  const servers = switchServersStore.servers;

  // Selector data for the addressing-policy editor, scoped to the chosen server.
  const roomsQuery = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId as string),
    enabled: serverId !== null,
  });
  const groupsQuery = useQuery({
    queryKey: ['remote-room-groups', serverId],
    queryFn: () => rpc.switchServers.listRemoteRoomGroups(serverId as string),
    enabled: serverId !== null,
  });
  const usersQuery = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId as string),
    enabled: serverId !== null,
  });
  const agentsQuery = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId as string),
    enabled: serverId !== null,
  });
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
  const { identities } = useMyIdentities(serverId);
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId as string),
    enabled: serverId !== null,
  });
  const unlinkedApps =
    identities === null || bridgesQuery.data === undefined
      ? null
      : bridgesQuery.data
          .filter((bridge) => !identities.some((identity) => identity.bridgeId === bridge.id))
          .map((bridge) => bridge.displayName);

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
            <Field>
              <label className="-mx-2 flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--sel-soft)]">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm">
                    Auto-create a session on notify
                    <InfoTooltip
                      label="More info about auto-creating a session"
                      content="Switch Console watches this agent's Switch rooms and starts a session — connected to the room and ready to reply — whenever it's addressed with no session running."
                    />
                  </span>
                  <span className="text-xs text-foreground-muted">
                    Start a session when this agent is addressed.
                  </span>
                </span>
                <Switch
                  className="mt-0.5"
                  checked={form.autoSession}
                  onCheckedChange={(checked) => form.setAutoSession(checked)}
                />
              </label>
            </Field>

            <Field>
              <label className="-mx-2 flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--sel-soft)]">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm">
                    Bypass permissions
                    <InfoTooltip
                      label="More info about bypassing permissions"
                      content="Sessions start with the provider's auto-approve flag, including ones started automatically. Turn it on only for agents you trust to run unattended."
                    />
                  </span>
                  <span className="text-xs text-foreground-muted">
                    Run this agent&apos;s sessions without permission prompts.
                  </span>
                </span>
                <Switch
                  className="mt-0.5"
                  checked={form.autoApprove}
                  onCheckedChange={(checked) => form.setAutoApprove(checked)}
                />
              </label>
            </Field>

            <Field>
              <FieldLabel>
                <span className="flex items-center gap-1.5">
                  Who can send instructions
                  <InfoTooltip
                    label="More info about addressing"
                    content="Sending instructions means an @mention, a targeted message, or a delegated task. A new agent answers only you; grant other agents to let them delegate to it. You can change this later from the agent's settings."
                  />
                </span>
              </FieldLabel>
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
export function AgentIdentityFields({ form }: { form: ConfigureAgentFormState }) {
  const nameId = useId();
  const descriptionId = useId();
  return (
    <FieldGroup>
      {/* Above the name, because it is the first thing the finished agent is
          recognised by — and it follows the name as it is typed, which only
          reads as cause and effect if it is on screen while you type. */}
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <AgentIconPicker
          name={form.agentName}
          iconUrl={form.iconUrl}
          onChange={form.setIconUrl}
          size={84}
        />
        <span className="text-xs text-foreground-muted">
          {form.iconUrl === null ? 'Automatically generated' : 'Click to change'}
        </span>
      </div>

      <Field>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          placeholder="Name this agent"
          value={form.agentName}
          onChange={(e) => form.setAgentName(e.target.value)}
          aria-invalid={form.agentName.length > 0 && !form.nameIsValid}
        />
        {form.agentName.length > 0 && !form.nameIsValid ? (
          <span className="text-destructive text-xs">
            Use lowercase letters, digits, <span className="font-mono">. - _</span>, starting with a
            letter or digit. No spaces or uppercase.
          </span>
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
        <span className="text-xs text-foreground-muted">
          Helps other people and agents understand what this agent is for.
        </span>
      </Field>
    </FieldGroup>
  );
}
