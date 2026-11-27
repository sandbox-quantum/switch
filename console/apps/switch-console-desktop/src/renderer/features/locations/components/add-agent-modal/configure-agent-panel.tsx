import {
  NewAgentIdentityFields,
  NewAgentSettingsSection,
} from '@switch-console/chat-ui/components/new-agent-form';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useEffect } from 'react';
import { AddressingPolicyControl } from '@renderer/features/switch-servers/addressing-policy-control';
import type { OptionItem } from '@renderer/features/switch-servers/addressing-policy-editor';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
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
    <NewAgentSettingsSection
      form={form}
      ownerUnreachable={ownerUnreachable}
      addressing={
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
      }
    >
      {children}
    </NewAgentSettingsSection>
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
  return (
    <NewAgentIdentityFields
      form={form}
      nameTaken={nameTaken}
      takenWhere="on this server"
      iconPicker={
        <AgentIconPicker
          forNewAgent
          serverId={serverId}
          name={form.agentName}
          iconUrl={form.iconUrl}
          onChange={form.setIconUrl}
          size={84}
        />
      }
    />
  );
}
