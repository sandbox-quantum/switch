/**
 * The repository a new Switch cloud agent works in: chosen from the owner's
 * GitHub connection, with a way into the GitHub connection step.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getGitHubConnection = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: { switchServers: { getGitHubConnection } },
}));

import { CloudAgentRepository } from '@renderer/features/locations/components/add-agent-modal/cloud-agent-repository';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  getGitHubConnection.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(onSelection = vi.fn(), onConnectGitHub = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CloudAgentRepository
          serverId="server-1"
          onSelection={onSelection}
          onConnectGitHub={onConnectGitHub}
        />
      </QueryClientProvider>
    )
  );
  return container;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(found).toBeDefined();
  return found!;
}

describe('a new Switch cloud agent’s repository', () => {
  it('chooses the only repository GitHub shares with Switch', async () => {
    getGitHubConnection.mockResolvedValue({
      status: 'connected',
      login: 'ada',
      install_url: 'https://github.example/install',
      installations: [
        {
          id: 12,
          account: 'example',
          repositories: [{ id: 34, name: 'example/project', permissions: { push: true } }],
        },
      ],
    });
    const onSelection = vi.fn();
    const el = await render(onSelection);
    await vi.waitFor(() =>
      expect(onSelection).toHaveBeenLastCalledWith({ installationId: 12, repositoryId: 34 })
    );
    expect(getGitHubConnection).toHaveBeenCalledWith('server-1');
    expect(el.textContent).toMatch(/Only repositories shared with Switch on GitHub appear here/);
    button(el, 'Manage GitHub access');
  });

  it('offers the GitHub connection step and chooses nothing until GitHub is connected', async () => {
    getGitHubConnection.mockResolvedValue({
      status: 'not_connected',
      install_url: 'https://github.example/install',
    });
    const onSelection = vi.fn();
    const onConnectGitHub = vi.fn();
    const el = await render(onSelection, onConnectGitHub);
    await vi.waitFor(() => expect(el.textContent).toMatch(/Connect GitHub to choose a repository/));
    expect(onSelection).toHaveBeenLastCalledWith(null);
    await act(async () => button(el, 'Connect GitHub').click());
    expect(onConnectGitHub).toHaveBeenCalled();
  });
});
