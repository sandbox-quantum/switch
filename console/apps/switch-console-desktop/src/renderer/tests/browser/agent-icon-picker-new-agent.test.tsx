import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
/**
 * What the icon picker shows when nothing has been chosen.
 *
 * For a new agent that is the icon it will be created with, drawn from a
 * digest of the name; for an existing agent it is the face its name already
 * draws, so no existing agent changes face.
 */
import { AgentIconPicker } from '@renderer/lib/components/agent-icon-picker';
import { avatarSettingsQueryKey } from '@renderer/lib/stores/use-avatar-settings';
import { agentAvatarUrlForName, agentAvatarUrlForNewAgent } from '@switch-console/chat-ui/model/agent-avatar';

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    switchServers: {
      avatarSettings: vi.fn(() => new Promise<never>(() => {})),
      agentIconChoices: vi.fn(() =>
        Promise.resolve({ choices: [], thirdPartyAvatarsEnabled: true })
      ),
    },
  },
}));

const SERVER_ID = 'srv-1';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function triggerImage(forNewAgent: boolean): Promise<string | null> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  client.setQueryData(avatarSettingsQueryKey(SERVER_ID), { thirdPartyAvatarsEnabled: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <AgentIconPicker
          forNewAgent={forNewAgent}
          serverId={SERVER_ID}
          name="acme-merger-bot"
          iconUrl={null}
          onChange={() => {}}
        />
      </QueryClientProvider>
    )
  );
  const trigger = container.querySelector('[aria-label="Change the agent\'s icon"]');
  return trigger?.querySelector('img')?.getAttribute('src') ?? null;
}

describe('the icon picker with nothing chosen', () => {
  it('shows a new agent the icon it will be created with, which carries no name', async () => {
    const src = await triggerImage(true);
    expect(src).toBe(agentAvatarUrlForNewAgent('acme-merger-bot'));
    expect(src).not.toContain('acme');
  });

  it('shows an existing agent the face its name already draws', async () => {
    expect(await triggerImage(false)).toBe(agentAvatarUrlForName('acme-merger-bot'));
  });
});
