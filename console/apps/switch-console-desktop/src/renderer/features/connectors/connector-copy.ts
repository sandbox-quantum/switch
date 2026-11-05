import type {
  ConnectionCatalogEntry,
  WorkspaceService,
} from '@shared/core/switch-servers/connection-catalog';

/** The most agents the disconnect dialog names before counting the rest. */
const NAMED_AGENTS = 4;

/**
 * What disconnecting says before it happens: how many of the person's agents
 * lose the service and which (the first four, then how many more), or, where
 * that cannot be known, that every one does; and, for a key, that Switch can
 * only forget it, not revoke it.
 */
export function disconnectCopy(
  entry: Pick<ConnectionCatalogEntry, 'name' | 'auth_type'>,
  grantedAgents: string[] | null
): { title: string; lines: string[] } {
  const { name } = entry;
  const lines = [
    grantedAgents === null
      ? `Disconnecting removes every agent's access to ${name}.`
      : grantedAgents.length === 0
        ? `None of your agents use ${name}.`
        : grantedAgents.length === 1
          ? `${grantedAgents[0]} loses ${name}.`
          : `${grantedAgents.length} agents lose ${name}: ${namedAgents(grantedAgents)}. Disconnecting removes their access.`,
  ];
  if (entry.auth_type === 'api_key') {
    lines.push('Switch removes the key it keeps.');
    lines.push(`Switch can't revoke this key at ${name}; delete it there.`);
  } else {
    lines.push(`Switch removes the sign-in it keeps for ${name}.`);
  }
  return { title: `Disconnect ${name}?`, lines };
}

function namedAgents(names: string[]): string {
  const named = names.slice(0, NAMED_AGENTS);
  const rest = names.length - named.length;
  const last = rest > 0 ? `${rest} more` : named.pop()!;
  return `${named.join(', ')} and ${last}`;
}

/**
 * What an admin is asked before switching a service off for the workspace, or
 * null when nobody is connected and no agent uses it: switching it off then
 * changes nothing anyone has, and is done without asking.
 */
export function switchOffConfirmation(
  service: Pick<WorkspaceService, 'name' | 'connected_members' | 'granted_agents'>
): { title: string; description: string } | null {
  const members = service.connected_members;
  const agents = service.granted_agents;
  if (members === 0 && agents === 0) return null;
  const connected = `${members} ${members === 1 ? 'member is' : 'members are'} connected`;
  const using = `${agents} ${agents === 1 ? 'agent uses' : 'agents use'} it`;
  return {
    title: `Switch ${service.name} off for this workspace?`,
    description: `${connected} and ${using}. Their sessions lose it within a minute.`,
  };
}

/** Who last changed a workspace switch, and when; a switch nobody touched takes the workspace's default. */
export function workspaceSwitchNote(
  service: Pick<WorkspaceService, 'enabled' | 'updated_by_name' | 'updated_at'>,
  formatTime: (iso: string) => string
): string {
  if (service.updated_at === null) return service.enabled ? 'On by default.' : 'Off by default.';
  const state = service.enabled ? 'on' : 'off';
  const who = service.updated_by_name ?? 'a deleted account';
  return `Switched ${state} by ${who}, ${formatTime(service.updated_at)}.`;
}
