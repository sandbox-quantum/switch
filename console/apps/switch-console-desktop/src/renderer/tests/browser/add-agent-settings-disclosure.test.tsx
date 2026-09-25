/**
 * When the add-agent dialog's Settings section opens itself (CHOO-2173).
 *
 * The section is folded because its defaults are usually right. They are not
 * right when the owner-only default meets a messaging app with no account
 * linked: the agent then answers nobody there, and the control says so — inside
 * the fold, where the person creating the agent never sees it. So the fold
 * opens itself for exactly that case and no other.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel's siblings reach the renderer IPC bridge at import time, which only
// exists inside Electron. Hoisted so it is in place before those modules are
// evaluated.
const remote = vi.hoisted(() => ({
  bridges: [] as { id: string; displayName: string }[],
  identities: [] as { bridgeId: string }[],
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    switchServers: {
      listRemoteRooms: () => Promise.resolve([]),
      listRemoteRoomGroups: () => Promise.resolve([]),
      listRemoteExternalUsers: () => Promise.resolve([]),
      listRemoteAgents: () => Promise.resolve([]),
      listRemoteBridges: () => Promise.resolve(remote.bridges),
      listMyIdentities: () => Promise.resolve(remote.identities),
    },
  },
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    servers: [{ id: 'srv-1', name: 'Test' }],
    init: () => Promise.resolve(),
  },
}));

import { AgentSettingsSection } from '@renderer/features/locations/components/add-agent-modal/configure-agent-panel';
import { useConfigureAgentForm } from '@renderer/features/locations/components/add-agent-modal/modes';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  remote.bridges = [];
  remote.identities = [];
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Panel() {
  const form = useConfigureAgentForm();
  return (
    <AgentSettingsSection
      form={form}
      serverId="srv-1"
      onAddServer={() => {}}
      onOpenMessagingApps={() => {}}
    />
  );
}

/** Renders the panel and lets the four server queries settle. */
async function renderPanel(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>
    )
  );
  // The warning depends on two queries resolving, and the fold opens in an
  // effect off their result — so flush until the tree stops settling.
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

function settingsRow(el: HTMLElement): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>('button[aria-expanded]')].find((b) =>
    b.textContent?.includes('Settings')
  );
  expect(found, 'no Settings disclosure row').toBeDefined();
  return found!;
}

describe('the add-agent Settings fold', () => {
  it('opens itself when the owner-only default reaches nobody', async () => {
    remote.bridges = [{ id: 'b-slack', displayName: 'Slack' }];
    remote.identities = [];

    const el = await renderPanel();

    expect(settingsRow(el).getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).toContain('you have not linked a messaging account');
  });

  it('stays folded when every app has an account linked', async () => {
    remote.bridges = [{ id: 'b-slack', displayName: 'Slack' }];
    remote.identities = [{ bridgeId: 'b-slack' }];

    const el = await renderPanel();

    expect(settingsRow(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('stays folded when the server has no messaging apps at all', async () => {
    // Nothing to link an account on is not a misconfiguration, so there is no
    // warning to surface and no reason to unfold.
    remote.bridges = [];

    const el = await renderPanel();

    expect(settingsRow(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('lets the reader fold it away again', async () => {
    // The fold opens once, as a way of showing the warning. Closing it is an
    // answer, so it must not spring back on the next render.
    remote.bridges = [{ id: 'b-slack', displayName: 'Slack' }];

    const el = await renderPanel();
    await act(async () => settingsRow(el).click());

    expect(settingsRow(el).getAttribute('aria-expanded')).toBe('false');
  });
});
