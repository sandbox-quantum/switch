/**
 * The connections a cloud agent is granted: each GitHub installation gets no
 * access, all its repositories, or a searchable selection of them. GitHub not
 * connected, or needing reconnecting, says so with a way to the Connections
 * page, and never stands in the way.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { ConnectionGrant } from '@shared/core/switch-servers/connection-grants';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const switchServers = vi.hoisted(() => ({
  getConnectionCatalog: vi.fn(),
  getGitHubConnection: vi.fn(),
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

import { ConnectionGrantsEditor } from '@renderer/features/switch-servers/connection-grants-editor';
import { useConnectionCatalog } from '@renderer/features/switch-servers/connections-step';

function entry(
  slug: string,
  name: string,
  status: ConnectionCatalogEntry['status']
): ConnectionCatalogEntry {
  return {
    slug,
    name,
    category: 'Development',
    description: `${name} access`,
    enabled: true,
    auth_type: 'oauth',
    status,
  };
}

const CONNECTED = {
  status: 'connected',
  login: 'example-user',
  install_url: 'https://github.example/install',
  installations: [
    { id: 123, account: 'acme', repositories: [{ id: 1, name: 'acme/api' }] },
    {
      id: 456,
      account: 'example-user',
      repositories: [
        { id: 111, name: 'example-user/demo' },
        { id: 222, name: 'example-user/docs' },
        { id: 333, name: 'example-user/site' },
      ],
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ConnectionGrant[] = [];

beforeEach(() => {
  switchServers.getConnectionCatalog.mockReset();
  switchServers.getGitHubConnection.mockReset();
  latest = [];
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function Harness({ initial, onConnect }: { initial: ConnectionGrant[]; onConnect: () => void }) {
  const catalog = useConnectionCatalog('server-1');
  const [value, setValue] = useState(initial);
  return (
    <ConnectionGrantsEditor
      catalog={catalog}
      value={value}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
      onConnect={onConnect}
    />
  );
}

async function render(initial: ConnectionGrant[] = [], onConnect = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness initial={initial} onConnect={onConnect} />));
  return container;
}

function button(within: ParentNode, text: RegExp): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
}

function installation(account: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(`[role="group"][aria-label="${account}"]`);
  expect(found).not.toBeNull();
  return found!;
}

function choice(account: string, label: string): HTMLElement {
  const found = installation(account).querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(found).not.toBeNull();
  return found!;
}

function checkbox(name: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${name}"]`);
  expect(found).not.toBeNull();
  return found!;
}

async function connected(initial: ConnectionGrant[] = []) {
  switchServers.getConnectionCatalog.mockResolvedValue([entry('github', 'GitHub', 'connected')]);
  switchServers.getGitHubConnection.mockResolvedValue(CONNECTED);
  const el = await render(initial);
  await vi.waitFor(() => expect(el.querySelector('[aria-label="acme"]')).not.toBeNull());
  return el;
}

describe('the connection grants editor', () => {
  it('starts every installation at no access, and grants none', async () => {
    await connected();
    expect(choice('acme', 'No access').getAttribute('aria-pressed')).toBe('true');
    expect(choice('example-user', 'No access').getAttribute('aria-pressed')).toBe('true');
    expect(switchServers.getGitHubConnection).toHaveBeenCalledWith('server-1');
  });

  it('grants all of one installation’s repositories', async () => {
    await connected();
    await act(async () => choice('acme', 'All repositories').click());
    expect(latest).toEqual([
      { slug: 'github', installations: [{ installation_id: 123, repositories: 'all' }] },
    ]);
    await act(async () => choice('acme', 'No access').click());
    expect(latest).toEqual([]);
  });

  it('grants the repositories chosen, found by search', async () => {
    const el = await connected();
    await act(async () => choice('example-user', 'Selected repositories').click());
    expect(el.textContent).toMatch(/0 repositories selected/);

    const search = el.querySelector<HTMLInputElement>(
      'input[aria-label="Search example-user repositories"]'
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'd');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const list = el.querySelector('[aria-label="example-user repositories"]')!;
    expect(list.textContent).toMatch(/example-user\/demo/);
    expect(list.textContent).toMatch(/example-user\/docs/);
    expect(list.textContent).not.toMatch(/example-user\/site/);

    await act(async () => checkbox('example-user/demo').click());
    await act(async () => checkbox('example-user/docs').click());
    expect(latest).toEqual([
      { slug: 'github', installations: [{ installation_id: 456, repositories: [111, 222] }] },
    ]);
    expect(el.textContent).toMatch(/2 repositories selected/);

    await act(async () => checkbox('example-user/demo').click());
    expect(latest).toEqual([
      { slug: 'github', installations: [{ installation_id: 456, repositories: [222] }] },
    ]);
  });

  it('shows the access an agent already has', async () => {
    await connected([
      {
        slug: 'github',
        installations: [
          { installation_id: 123, repositories: 'all' },
          { installation_id: 456, repositories: [333] },
        ],
      },
    ]);
    expect(choice('acme', 'All repositories').getAttribute('aria-pressed')).toBe('true');
    expect(choice('example-user', 'Selected repositories').getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(checkbox('example-user/site').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('example-user/demo').getAttribute('aria-checked')).toBe('false');
  });

  it('offers to connect GitHub when it is not connected', async () => {
    switchServers.getConnectionCatalog.mockResolvedValue([
      entry('github', 'GitHub', 'not_connected'),
    ]);
    const onConnect = vi.fn();
    const el = await render([], onConnect);
    await vi.waitFor(() => expect(el.textContent).toMatch(/Not connected/));
    expect(switchServers.getGitHubConnection).not.toHaveBeenCalled();
    expect(el.querySelector('[role="group"]')).toBeNull();
    await act(async () => button(el, /^Connect$/)!.click());
    expect(onConnect).toHaveBeenCalled();
  });

  it('says GitHub needs reconnecting, with a way to do it', async () => {
    switchServers.getConnectionCatalog.mockResolvedValue([entry('github', 'GitHub', 'connected')]);
    switchServers.getGitHubConnection.mockRejectedValue(
      new RpcError(
        serializeRpcError(
          Object.assign(new Error('Switch gateway returned 422'), {
            name: 'GatewayError',
            kind: 'http',
            status: 422,
            detail: 'GitHub authorization expired or was revoked. Reconnect GitHub.',
            code: 'github_reconnect_required',
          })
        )
      )
    );
    const onConnect = vi.fn();
    const el = await render([], onConnect);
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(
        'GitHub authorization expired or was revoked. Reconnect GitHub.'
      )
    );
    await act(async () => button(el, /^Reconnect$/)!.click());
    expect(onConnect).toHaveBeenCalled();
  });
});
