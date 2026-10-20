/**
 * The server home's "Link your <app> account" reminder.
 *
 * Adding an app ends with a link step the person may skip. While their account
 * on an active app stays unlinked the server home keeps offering it, and the
 * offer goes away once the account is claimed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const listMyIdentities = vi.hoisted(() => vi.fn());
const showModal = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { workspaces: { listMyIdentities } },
  events: { on: () => () => {}, emit: () => {} },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => showModal(id, args),
}));

import { LinkAccountPrompts } from '@renderer/features/switch-servers/link-account-prompts';
import {
  myIdentitiesQueryKey,
  useMyIdentities,
} from '@renderer/features/switch-servers/use-my-identities';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

function bridge(id: string, type: string, patch: Partial<RemoteBridge> = {}): RemoteBridge {
  return {
    id,
    type,
    displayName: `${type} workspace`,
    status: 'active',
    isDefault: false,
    homeUrl: null,
    channelCreationSupported: true,
    canCreateChannels: true,
    directorySearchSupported: true,
    attention: null,
    teamPlacementSupported: false,
    channelIdsRefused: null,
    receivesWebhooks: false,
    webhookUrl: null,
    ...patch,
  };
}

const SLACK_IDENTITY: LinkedIdentity = {
  id: 'eu-1',
  bridgeId: 'b-slack',
  bridgeDisplayName: 'slack workspace',
  bridgeType: 'slack',
  externalUserId: 'U1',
  externalUsername: 'me',
};

function Home({ bridges }: { bridges: RemoteBridge[] }) {
  const { identities } = useMyIdentities('ws-1');
  return <LinkAccountPrompts workspaceId="ws-1" bridges={bridges} identities={identities} />;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  listMyIdentities.mockReset();
  showModal.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(bridges: RemoteBridge[]): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Home bridges={bridges} />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

describe('the link-your-account reminder', () => {
  it('shows while the Slack account is unlinked, and goes once it is claimed', async () => {
    listMyIdentities.mockResolvedValueOnce([]).mockResolvedValue([SLACK_IDENTITY]);
    const el = await render([bridge('b-slack', 'slack')]);

    expect(el.textContent).toContain('Link your Slack account');
    const link = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Link account')
    );
    await act(async () => link!.click());
    expect(showModal).toHaveBeenCalledWith('claimIdentityModal', {
      workspaceId: 'ws-1',
      bridgeId: 'b-slack',
    });

    // What the claim does on success: re-read the person's linked accounts.
    await act(async () => client.invalidateQueries({ queryKey: myIdentitiesQueryKey('ws-1') }));
    await settle();

    expect(el.textContent).not.toContain('Link your Slack account');
  });

  it('names each unlinked app, Telegram included', async () => {
    listMyIdentities.mockResolvedValue([SLACK_IDENTITY]);
    const el = await render([
      bridge('b-slack', 'slack'),
      bridge('b-tg', 'telegram', { directorySearchSupported: false }),
    ]);

    expect(el.textContent).toContain('Link your Telegram account');
    expect(el.textContent).not.toContain('Link your Slack account');
  });

  it('says nothing while the linked accounts are still loading', async () => {
    listMyIdentities.mockReturnValue(new Promise(() => {}));
    const el = await render([bridge('b-slack', 'slack')]);

    expect(el.textContent).toBe('');
  });

  it('leaves out an app whose connection is down', async () => {
    listMyIdentities.mockResolvedValue([]);
    const el = await render([bridge('b-slack', 'slack', { status: 'error' })]);

    expect(el.textContent).toBe('');
  });
});
