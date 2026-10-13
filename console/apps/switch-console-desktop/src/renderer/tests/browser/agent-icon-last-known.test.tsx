import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => ({ agents: [] as { id: string; iconUrl: string | null }[] }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { listAgents: async () => listed.agents } },
}));

import {
  useAgentIconUrl,
  workspaceAgentsQueryKey,
} from '@renderer/lib/stores/use-workspace-agents';

function Probe() {
  return <span>{useAgentIconUrl('w', 'a') ?? 'none'}</span>;
}

it('keeps the icon an agent last had while its server lists no agents', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  listed.agents = [{ id: 'a', iconUrl: 'https://icons/gaze.png' }];
  await act(async () =>
    createRoot(host).render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  await settle();
  expect(host.textContent).toBe('https://icons/gaze.png');

  listed.agents = [];
  await act(async () => client.invalidateQueries({ queryKey: workspaceAgentsQueryKey('w') }));
  await settle();
  expect(host.textContent).toBe('https://icons/gaze.png');

  listed.agents = [{ id: 'a', iconUrl: null }];
  await act(async () => client.invalidateQueries({ queryKey: workspaceAgentsQueryKey('w') }));
  await settle();
  expect(host.textContent).toBe('none');
});
