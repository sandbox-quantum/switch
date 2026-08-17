import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { InfoTooltip } from '@renderer/features/settings/components/InfoTooltip';
import { AddressingPolicyControl } from '@renderer/features/switch-servers/addressing-policy-control';
import {
  type OptionItem,
  policyHasDeadRule,
} from '@renderer/features/switch-servers/addressing-policy-editor';
import { useMyIdentities } from '@renderer/features/switch-servers/use-my-identities';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import type { AddressingPolicy } from '@shared/core/switch-servers/switch-servers';

/**
 * Per-Switch-agent scoped addressing policy (CHOO-1585) — who may address the
 * agent (@mention, targeted message, task delegation). One editor per
 * Switch-linked agent in the location; hidden when the location has none.
 */
export function AddressingPolicySettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent; omit to show every Switch-linked agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const switchAgents = (agents ?? []).filter(
    (a) => a.serverId && a.switchAgentId && (!agentId || a.id === agentId)
  );
  if (switchAgents.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {switchAgents.map((agent) => (
        <AddressingPolicyRow
          key={agent.id}
          serverId={agent.serverId as string}
          agentId={agent.switchAgentId as string}
          agentName={agent.name}
          showName={switchAgents.length > 1}
        />
      ))}
    </div>
  );
}

function AddressingPolicyRow({
  serverId,
  agentId,
  agentName,
  showName,
}: {
  serverId: string;
  agentId: string;
  agentName: string;
  showName: boolean;
}) {
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const { identities } = useMyIdentities(serverId);
  const [draft, setDraft] = useState<AddressingPolicy | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const policyKey = ['agent-addressing-policy', serverId, agentId];
  const { data: saved } = useQuery({
    queryKey: policyKey,
    queryFn: () => rpc.switchServers.getAddressingPolicy({ serverId, agentId }),
  });
  const rooms = useQuery({
    queryKey: ['remote-rooms', serverId],
    queryFn: () => rpc.switchServers.listRemoteRooms(serverId),
  });
  const groups = useQuery({
    queryKey: ['remote-room-groups', serverId],
    queryFn: () => rpc.switchServers.listRemoteRoomGroups(serverId),
  });
  const users = useQuery({
    queryKey: ['remote-external-users', serverId],
    queryFn: () => rpc.switchServers.listRemoteExternalUsers(serverId),
  });
  const remoteAgents = useQuery({
    queryKey: ['remote-agents', serverId],
    queryFn: () => rpc.switchServers.listRemoteAgents(serverId),
  });
  const bridges = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
  });
  // The apps on this server the user has claimed no account on. Null until both
  // halves have arrived: a bridge list without the identities would read as
  // every app unlinked.
  const unlinkedApps =
    identities === null || bridges.data === undefined
      ? null
      : bridges.data
          .filter((bridge) => !identities.some((identity) => identity.bridgeId === bridge.id))
          .map((bridge) => bridge.displayName);

  // Until the user edits, show the saved policy; once dirty, show the draft.
  const value = dirty ? draft : (saved ?? null);

  const mutation = useMutation({
    mutationFn: (policy: AddressingPolicy | null) =>
      rpc.switchServers.updateAddressingPolicy({ serverId, agentId, policy }),
    onSuccess: (_result, policy) => {
      queryClient.setQueryData(policyKey, policy);
      setDirty(false);
      setError(null);
    },
    onError: (err) => {
      setError(failureText(err, 'Could not save the addressing policy.'));
      log.error('Failed to update addressing policy', { agentId, error: err });
    },
  });

  const roomOptions: OptionItem[] = (rooms.data ?? []).map((r) => ({ id: r.id, label: r.name }));
  const groupOptions: OptionItem[] = (groups.data ?? []).map((g) => ({ id: g.id, label: g.name }));
  const userOptions: OptionItem[] = (users.data ?? []).map((u) => ({
    id: u.id,
    label: u.username,
  }));
  const agentOptions: OptionItem[] = (remoteAgents.data ?? []).map((a) => ({
    id: a.id,
    label: a.name,
  }));
  // Prefer the registered Switch agent name over the local directory basename.
  const displayName = agentOptions.find((o) => o.id === agentId)?.label ?? agentName;

  // Saved the moment it is changed — there is no Save button. A rule set that
  // admits nobody is the one exception: it is held as a draft rather than
  // written, because saving it mid-edit would silently shut the agent off.
  const change = (next: AddressingPolicy | null) => {
    setDraft(next);
    setDirty(true);
    if (!policyHasDeadRule(next)) mutation.mutate(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {showName && <span className="text-sm font-medium">{displayName}</span>}
      <AddressingPolicyControl
        value={value}
        onChange={change}
        inlineLabel={
          <span className="flex items-center gap-1.5 text-sm leading-snug font-medium">
            Who can send instructions
            <InfoTooltip
              label="More info about addressing"
              content="Sending instructions means an @mention, a targeted message, or a delegated task. Only you, anyone in the agent's rooms, or whoever a rule admits."
            />
          </span>
        }
        rooms={roomOptions}
        roomGroups={groupOptions}
        users={userOptions}
        agents={agentOptions}
        unlinkedApps={unlinkedApps}
        onOpenMessagingApps={() => navigate('server', { serverId })}
        disabled={mutation.isPending}
      />
      {error && <span className="text-destructive text-xs">{error}</span>}
      {policyHasDeadRule(value) && (
        <span className="text-xs text-foreground-warning">
          Not saved — a rule admits nobody. It is kept here until it names a sender.
        </span>
      )}
    </div>
  );
}
