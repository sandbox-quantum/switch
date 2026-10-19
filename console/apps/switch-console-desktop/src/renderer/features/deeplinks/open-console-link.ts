import { toast } from 'sonner';
import { isAgentSection } from '@renderer/features/managed-agents/agent-sections';
import type { SettingsPageTab } from '@renderer/features/settings/components/SettingsPage';
import { isBuddy } from '@renderer/features/switch-buddy/buddy-identity';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { type ConsoleLink, parseConsoleLink } from '@shared/core/deeplinks/console-links';

/**
 * Open the page a `switchdash://open/…` link points at: from a click in the
 * app's own chat, or handed over by the OS. A link that cannot be followed —
 * malformed, for a server this Console is not connected to, for an agent it
 * cannot show — says so rather than leaving the person where they were with
 * no idea why.
 */
export async function openConsoleLink(raw: string): Promise<void> {
  const parsed = parseConsoleLink(raw);
  if (!parsed.ok) {
    toast.error('Could not open that link', { description: parsed.reason });
    return;
  }
  const { link } = parsed;
  if (link.page === 'settings') {
    appState.navigation.navigate('settings', {
      tab: (link.tab ?? 'general') as SettingsPageTab,
    });
    return;
  }
  const serverId = serverFor(link);
  if (serverId === null) return;
  if (switchServersStore.activeServerId !== serverId) await switchServersStore.setActive(serverId);
  await openOnServer(serverId, link);
}

/** The server a link means: the one it names, else the one on screen. */
function serverFor(link: ConsoleLink): string | null {
  if (link.server === null) {
    const active = switchServersStore.activeServerId;
    if (active === null)
      toast.error('Could not open that link', {
        description: 'Connect to a Switch server first.',
      });
    return active;
  }
  const origin = originOf(link.server);
  const match = switchServersStore.servers.find(
    (server) => origin !== null && originOf(server.gatewayUrl) === origin
  );
  if (!match) {
    toast.error('Could not open that link', {
      description: `It is for ${link.server}, which this Switch Console is not connected to.`,
    });
    return null;
  }
  return match.id;
}

function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

async function openOnServer(serverId: string, link: ConsoleLink): Promise<void> {
  const navigation = appState.navigation;
  switch (link.page) {
    case 'home':
      navigation.navigate('server', { serverId });
      return;
    case 'agents':
      navigation.navigate('serverAgents', { serverId });
      return;
    case 'agents/new':
      navigation.navigate('serverAgents', { serverId });
      showModal('addAgentModal', { entryPoint: 'link' });
      return;
    case 'agent':
      await openAgent(serverId, link.id!, link.tab);
      return;
    case 'rooms':
      navigation.navigate('serverRooms', { serverId });
      return;
    case 'room':
      navigation.navigate('room', { roomId: link.id! });
      return;
    case 'chat':
      navigation.navigate('chat', { serverId, roomId: link.id!, agentId: null });
      return;
    case 'buddy':
      await openBuddy(serverId, link.tab);
      return;
    case 'templates':
      navigation.navigate('templates', {
        serverId,
        ...(link.tab ? { kind: link.tab as 'agent' | 'room' | 'group' } : {}),
      });
      return;
    case 'template':
      navigation.navigate('templateDetail', { serverId, templateId: link.id! });
      return;
    case 'messaging-apps/connect':
      navigation.navigate('server', { serverId });
      showModal('connectMessagingAppModal', { serverId, onClosed: () => {} });
      return;
    case 'connections':
      navigation.navigate('connectors', { serverId });
      return;
    case 'invite': {
      const workspaceId = workspacesStore.idOnServerInScope(serverId);
      if (workspaceId === null) {
        toast.error('Could not open that link', {
          description: 'Open a workspace on this server first.',
        });
        return;
      }
      showModal('invitePeopleModal', { workspaceId });
      return;
    }
    case 'settings':
      return;
  }
}

/**
 * switch-buddy's page: its agent page once it exists, on the section the link's tab
 * names, else the page that sets it up, where there are no tabs yet.
 */
async function openBuddy(serverId: string, tab: string | null): Promise<void> {
  const agents = await rpc.managedAgents.list(serverId).catch(() => null);
  const buddy = agents?.find(isBuddy) ?? null;
  if (buddy === null) {
    appState.navigation.navigate('switchBuddy', { serverId });
    return;
  }
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId: buddy.agentId,
    name: buddy.name,
    ...(isAgentSection(tab) ? { section: tab } : {}),
  });
}

/** An agent's page is its managed-agent page; one Console does not manage has none here. */
async function openAgent(serverId: string, agentId: string, tab: string | null): Promise<void> {
  const agents = await rpc.managedAgents.list(serverId).catch(() => null);
  const agent = agents?.find((listed) => listed.agentId === agentId) ?? null;
  if (agent === null) {
    toast.error('Could not open that agent', {
      description: "It isn't one of your agents on this server, so it has no page here.",
    });
    return;
  }
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId,
    name: agent.name,
    ...(isAgentSection(tab) ? { section: tab } : {}),
  });
}
