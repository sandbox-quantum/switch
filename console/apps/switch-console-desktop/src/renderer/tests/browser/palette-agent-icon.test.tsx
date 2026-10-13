import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { runInAction } from 'mobx';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * The face an agent wears in search (CHOO-2203).
 *
 * Search was the one surface the custom-agent-icon work never reached: it drew
 * the agent's *provider* logo, so every Claude Code agent was the same picture
 * and none of them was its own. Pinned here because the wrong icon is still an
 * icon — nothing else in the suite can tell the two apart.
 */
import { PaletteAgentItem } from '@renderer/features/command-palette/palette-agent-item';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { ThemeContext } from '@renderer/lib/providers/theme-provider';
import { AGENTS_METADATA_QUERY_KEY } from '@renderer/lib/stores/use-agents';
import { avatarSettingsQueryKey } from '@renderer/lib/stores/use-avatar-settings';
import { workspaceAgentsQueryKey } from '@renderer/lib/stores/use-workspace-agents';
import type { Agent } from '@shared/core/agents/agents';
import type { SearchItem } from '@shared/core/search';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

const LOCATION_ID = 'loc-1';
const SERVER_ID = 'server-1';
const WORKSPACE_ID = 'workspace-1';
const SWITCH_AGENT_ID = 'switch-agent-1';
const AGENT_NAME = 'reviewer';

const AGENT: Agent = {
  id: 'agent-row-1',
  locationId: LOCATION_ID,
  name: AGENT_NAME,
  providerId: 'claude',
  switchAgentId: SWITCH_AGENT_ID,
  apiEndpoint: 'https://switch.example',
  workspaceId: WORKSPACE_ID,
  serverId: SERVER_ID,
  status: null,
  autoApprove: false,
  ownerName: null,
  providerConfig: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const HIT: SearchItem = {
  kind: 'agent',
  id: AGENT.id,
  locationId: LOCATION_ID,
  sessionId: null,
  title: AGENT_NAME,
  subtitle: '',
  score: 1,
};

function remoteAgent(iconUrl: string | null): RemoteAgentSummary {
  return {
    id: SWITCH_AGENT_ID,
    name: AGENT_NAME,
    displayName: null,
    description: '',
    connectorType: 'agent',
    ownerId: null,
    ownerName: null,
    knownAgentType: 'claude-code',
    knownAgentOptions: null,
    addressingPolicy: null,
    iconUrl,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const THEME = {
  theme: 'emlight' as const,
  setTheme: () => {},
  toggleTheme: () => {},
  effectiveTheme: 'emlight' as const,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  runInAction(() => agentsStore.byLocation.clear());
});

/**
 * What the search row drew for the agent: the `src` of its picture, or null
 * when it drew initials instead (no third-party avatar allowed, or none
 * chosen).
 */
async function rowAvatar(options: {
  /** Seed the local agent row, as a hit on a known agent would find it. A
   * miss (false) means the row has no server to ask either, so it is also
   * how "no server known" is exercised here. */
  known: boolean;
  /** The icon the server holds for it, or null for none. */
  iconUrl: string | null;
  /** The owning server's `THIRD_PARTY_AVATARS_ENABLED` answer. Left unset to
   * exercise "not known yet" — `known: false` makes this moot, since there is
   * then no server id to ask about. */
  thirdPartyAvatarsEnabled?: boolean;
}): Promise<string | null> {
  if (options.known) {
    runInAction(() => agentsStore.byLocation.set(LOCATION_ID, [AGENT]));
  }

  const client = new QueryClient({
    // staleTime keeps the seeded list from being refetched over IPC, which the
    // test has no main process to answer.
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  client.setQueryData(workspaceAgentsQueryKey(WORKSPACE_ID), [remoteAgent(options.iconUrl)]);
  // The provider mark beside the name reads its artwork from here. Seeded empty
  // so it resolves to nothing rather than reaching for a main process the test
  // does not have; the mark itself is the sidebar's, already covered there.
  client.setQueryData(AGENTS_METADATA_QUERY_KEY, []);
  if (options.thirdPartyAvatarsEnabled !== undefined) {
    client.setQueryData(avatarSettingsQueryKey(SERVER_ID), {
      thirdPartyAvatarsEnabled: options.thirdPartyAvatarsEnabled,
    });
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeContext.Provider value={THEME}>
          <Command>
            <Command.List>
              <PaletteAgentItem item={HIT} value="agent:1" onSelect={() => {}} />
            </Command.List>
          </Command>
        </ThemeContext.Provider>
      </QueryClientProvider>
    )
  );

  // `alt=""` is the avatar's; the provider mark carries its provider's name.
  const img = container.querySelector('img[alt=""]');
  return img ? img.getAttribute('src') : null;
}

describe('an agent in search', () => {
  it('wears its own chosen icon', async () => {
    const src = await rowAvatar({ known: true, iconUrl: 'https://icons.example/reviewer.png' });
    expect(src).toBe('https://icons.example/reviewer.png');
  });

  it('falls back to the face drawn from its name on a server that allows it, not its provider logo', async () => {
    const src = await rowAvatar({ known: true, iconUrl: null, thirdPartyAvatarsEnabled: true });
    expect(src).toContain('/gaze/png?');
    expect(src).toContain(AGENT_NAME);
  });

  it('withholds the generated face when its server disables third-party avatars', async () => {
    const src = await rowAvatar({ known: true, iconUrl: null, thirdPartyAvatarsEnabled: false });
    expect(src).toBeNull();
  });

  it('still shows a custom icon even when its server disables third-party avatars', async () => {
    const src = await rowAvatar({
      known: true,
      iconUrl: 'https://icons.example/reviewer.png',
      thirdPartyAvatarsEnabled: false,
    });
    expect(src).toBe('https://icons.example/reviewer.png');
  });

  it('shows initials rather than a face when the app holds no local row for the hit', async () => {
    // The lookup that used to supply the provider id can miss — a stale index
    // entry, an agent removed since. A miss leaves no server to ask about
    // third-party avatars either, so this is the same "unknown" case the
    // privacy setting fails closed on: no name-seeded avatar until Console
    // knows the server allows it.
    const src = await rowAvatar({ known: false, iconUrl: null });
    expect(src).toBeNull();
  });
});
