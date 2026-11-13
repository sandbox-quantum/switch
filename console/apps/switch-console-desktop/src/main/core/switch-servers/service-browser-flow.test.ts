import { createServer, request, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { focusMainWindow } from '@main/app/window';
import { log } from '@main/lib/logger';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelServiceConnection,
  completeServiceConnection,
  failServiceConnection,
  getConnectionCatalog,
  getServiceFlow,
  startServiceConnection,
} from './gateway-client';
import {
  cancelServiceBrowserFlow,
  getServiceBrowserFlow,
  startServiceBrowserFlow,
} from './service-browser-flow';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/app/window', () => ({ focusMainWindow: vi.fn() }));
vi.mock('./gateway-client', () => ({
  cancelServiceConnection: vi.fn(),
  completeServiceConnection: vi.fn(),
  failServiceConnection: vi.fn(),
  getConnectionCatalog: vi.fn(),
  getServiceFlow: vi.fn(),
  startServiceConnection: vi.fn(),
}));
const server = {
  id: 'server',
  url: 'https://switch.example.test',
  dashboardUrl: null,
} as SwitchServer;
const flows: [string, string][] = [];
/** The service as the server lists it: on any port, or only on `ports`. */
function listed(ports: number[] | null): ConnectionCatalogEntry[] {
  return [
    {
      slug: 'example',
      name: 'Example',
      category: 'Project management',
      description: 'Example work items.',
      enabled: true,
      auth_type: 'oauth',
      connectable: true,
      status: 'not_connected',
      unavailable_reason: null,
      unavailable_code: null,
      read_only_reason: null,
      pass_through: true,
      token_lifetime: 28_800,
      agent_access_note: null,
      loopback_ports: ports,
      key: null,
      sign_in_choices: null,
      paste: [],
      method: null,
      access_note: null,
      reconnect_code: null,
      reconnect_reason: null,
      external_identity: null,
      choices: null,
      consent: null,
      workspace_enabled: null,
      organization_locked: false,
    },
  ];
}
beforeEach(() => {
  vi.mocked(getConnectionCatalog).mockResolvedValue(listed(null));
});
afterEach(async () => {
  for (const [service, id] of flows.splice(0)) await cancelServiceBrowserFlow(server, service, id);
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function start(service = 'example', choices: Record<string, string> = {}) {
  vi.mocked(cancelServiceConnection).mockResolvedValue(undefined);
  vi.mocked(completeServiceConnection).mockResolvedValue({
    warning: null,
    consent: 'write',
    account: 'ada@example.test',
  });
  vi.mocked(startServiceConnection).mockImplementation(async (_server, _service, input) => ({
    id: input.state,
    url: 'https://auth.example.test/authorize',
    mode: 'loopback',
    callback_url: null,
  }));
  const open = vi.fn().mockResolvedValue(undefined);
  const { id, callbackUrl } = await startServiceBrowserFlow(server, service, choices, open);
  expect(callbackUrl).toBeNull();
  flows.push([service, id]);
  const input = vi.mocked(startServiceConnection).mock.calls[0]![2];
  return { id, input, open, url: `http://127.0.0.1:${input.port}/switch-services/callback` };
}

it('starts with what the person picked, and takes the code back past what the vendor adds', async () => {
  const { id, input, url } = await start('example', { site: 'eu.example.test' });
  expect(input.choices).toEqual({ site: 'eu.example.test' });
  // Datadog sends its site, domain and organization beside the code.
  const extras = new URLSearchParams({
    code: 'SYNTHETIC',
    state: id,
    site: 'https://app.eu.example.test',
    domain: 'app.eu.example.test',
    dd_oid: 'org-1',
    dd_org_name: 'Example Org',
  });
  const response = await fetch(`${url}?${extras}`);
  expect(response.status).toBe(200);
  expect(completeServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    'SYNTHETIC',
    input.completion_secret
  );
});

it('takes back only this Console’s state, and hands the code to Core with its secret', async () => {
  const { id, input, open, url } = await start();
  expect(open).toHaveBeenCalledExactlyOnceWith('https://auth.example.test/authorize');
  expect(open.mock.calls[0]![0]).not.toContain(input.completion_secret);
  expect((await fetch(url + '?state=unknown&code=SYNTHETIC')).status).toBe(400);
  expect(
    (await fetch(url.replace('switch-services', 'switch-github') + `?state=${id}&code=SYNTHETIC`))
      .status
  ).toBe(400);
  expect(completeServiceConnection).not.toHaveBeenCalled();
  expect(focusMainWindow).not.toHaveBeenCalled();
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(200);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toContain('Signed in to Example, and connected to Switch.');
  expect(focusMainWindow).toHaveBeenCalledOnce();
  expect(completeServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    'SYNTHETIC',
    input.completion_secret
  );
});

it('ends the flow once it reads connected, and tells the server to drop it', async () => {
  const { id } = await start();
  vi.mocked(getServiceFlow).mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  expect((await getServiceBrowserFlow(server, 'example', id)).status).toBe('pending');
  expect(cancelServiceConnection).not.toHaveBeenCalled();
  vi.mocked(getServiceFlow).mockResolvedValue({
    status: 'connected',
    account: 'ada@example.test',
    error: null,
    warning: 'Access stays a while.',
  });
  expect((await getServiceBrowserFlow(server, 'example', id)).warning).toBe(
    'Access stays a while.'
  );
  expect(cancelServiceConnection).toHaveBeenCalledWith(server, 'example', id);
  await expect(getServiceBrowserFlow(server, 'example', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
});

it('keeps a failed flow readable until the person cancels it', async () => {
  const { id } = await start();
  vi.mocked(getServiceFlow).mockResolvedValue({
    status: 'failed',
    account: null,
    error: 'This Example account is already linked to another Switch user in this workspace.',
    warning: null,
  });
  expect((await getServiceBrowserFlow(server, 'example', id)).status).toBe('failed');
  expect((await getServiceBrowserFlow(server, 'example', id)).status).toBe('failed');
  expect(cancelServiceConnection).not.toHaveBeenCalled();
});

it('takes back a code as long as a vendor issues, and nothing absurdly long', async () => {
  // Atlassian's codes are signed tokens: 2,177 characters in a live sign-in.
  const { id, input, url } = await start();
  expect((await fetch(url + `?state=${id}&code=${'x'.repeat(9000)}`)).status).toBe(400);
  const long = 'x'.repeat(2177);
  expect((await fetch(url + `?state=${id}&code=${long}`)).status).toBe(200);
  expect(completeServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    long,
    input.completion_secret
  );
});

it('refuses a request whose Host is not 127.0.0.1, as a rebound DNS name sends', async () => {
  const { id, input, url } = await start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    request(url + `?state=${id}&code=SYNTHETIC`, { headers: { Host: `localhost:${input.port}` } })
      .on('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject)
      .end();
  });
  expect(status).toBe(400);
  expect(completeServiceConnection).not.toHaveBeenCalled();
});

it('keys each flow by its service', async () => {
  const { id } = await start('example');
  await expect(getServiceBrowserFlow(server, 'other', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
  expect(getServiceFlow).not.toHaveBeenCalled();
});

it('does not show Core’s refusal in the browser, and sends the person to Console', async () => {
  const { id, url } = await start();
  vi.mocked(completeServiceConnection).mockRejectedValue(new Error('Private server detail'));
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(400);
  const text = await response.text();
  expect(text).not.toContain('Private server detail');
  expect(text).toContain('Switch Console says what happened');
});

it.each([
  [
    new Error('Could not reach https://switch.example.test: fetch failed'),
    'Could not reach https://switch.example.test: fetch failed',
  ],
  ['no message', 'Switch could not finish signing in to Example.'],
])('fails the sign-in at once when handing the code to the server fails', async (cause, said) => {
  const pending = { status: 'pending' as const, account: null, error: null, warning: null };
  const { id, url } = await start();
  vi.mocked(completeServiceConnection).mockRejectedValue(cause);
  expect((await fetch(url + `?state=${id}&code=SYNTHETIC`)).status).toBe(400);
  vi.mocked(getServiceFlow).mockResolvedValue(pending);
  expect(await getServiceBrowserFlow(server, 'example', id)).toEqual({
    ...pending,
    status: 'failed',
    error: said,
  });
});

it('ends the sign-in at once when the vendor refuses it, and says why in the browser', async () => {
  const { id, input, url } = await start();
  vi.mocked(failServiceConnection).mockResolvedValue(undefined);
  const refusal = new URLSearchParams({
    state: id,
    error: 'server_error',
    error_description: 'Your <b>identity provider</b> refused Example',
  });
  const response = await fetch(`${url}?${refusal}`);
  expect(response.status).toBe(400);
  const text = await response.text();
  expect(text).toContain(
    '<p>Example refused the sign-in: Your identity provider refused Example. Return to Switch Console.</p>'
  );
  expect(focusMainWindow).toHaveBeenCalledOnce();
  expect(failServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    'server_error',
    'Your identity provider refused Example',
    input.completion_secret
  );
  // The listener is done with this sign-in: a code after the refusal is not taken.
  await fetch(url + `?state=${id}&code=SYNTHETIC`).then(
    (again) => expect(again.status).toBe(400),
    () => {}
  );
  expect(completeServiceConnection).not.toHaveBeenCalled();
  const failed = {
    status: 'failed' as const,
    account: null,
    error: 'Example refused the sign-in: Your identity provider refused Example.',
    warning: null,
  };
  vi.mocked(getServiceFlow).mockResolvedValue(failed);
  expect(await getServiceBrowserFlow(server, 'example', id)).toEqual(failed);
});

it('takes a refusal only for this Console’s state', async () => {
  const { id, url } = await start();
  const response = await fetch(url + '?state=unknown&error=access_denied');
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('was not started by this Switch Console');
  expect(failServiceConnection).not.toHaveBeenCalled();
  expect((await fetch(url + `?state=${id}&code=SYNTHETIC`)).status).toBe(200);
});

it('shows the vendor’s refusal even when the server cannot be told of it', async () => {
  const { id, url } = await start();
  vi.mocked(failServiceConnection).mockRejectedValue(new Error('Switch gateway returned 404'));
  const response = await fetch(url + `?state=${id}&error=access_denied`);
  expect(await response.text()).toContain(
    'Example sign-in was cancelled. Return to Switch Console.'
  );
  expect(log.warn).toHaveBeenCalledOnce();
  vi.mocked(getServiceFlow).mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  expect(await getServiceBrowserFlow(server, 'example', id)).toEqual({
    status: 'failed',
    account: null,
    error: 'Example sign-in was cancelled.',
    warning: null,
  });
});

it('closes the listener when the person cancels', async () => {
  const { id, url } = await start();
  await cancelServiceBrowserFlow(server, 'example', id);
  expect(cancelServiceConnection).toHaveBeenCalledWith(server, 'example', id);
  await expect(fetch(url)).rejects.toThrow();
  await expect(getServiceBrowserFlow(server, 'example', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
});

it('hands on the server’s callback when the sign-in returns through it', async () => {
  const callback = 'https://switch.example.test/gateway/service-connections/example/flows/callback';
  vi.mocked(startServiceConnection).mockImplementation(async (_server, _service, input) => ({
    id: input.state,
    url: `https://switch.example.test/gateway/service-connections/example/flows/authorize?state=${input.state}`,
    mode: 'core',
    callback_url: callback,
  }));
  const started = await startServiceBrowserFlow(
    server,
    'example',
    {},
    vi.fn().mockResolvedValue(undefined)
  );
  flows.push(['example', started.id]);
  expect(started).toEqual({
    id: vi.mocked(startServiceConnection).mock.calls[0]![2].state,
    callbackUrl: callback,
  });
});

it('cancels the server flow if the browser cannot open', async () => {
  vi.mocked(startServiceConnection).mockImplementation(async (_server, _service, input) => ({
    id: input.state,
    url: 'https://auth.example.test/authorize',
    mode: 'loopback',
    callback_url: null,
  }));
  await expect(
    startServiceBrowserFlow(server, 'example', {}, async () => {
      throw new Error('Private shell detail');
    })
  ).rejects.toThrow('Could not open the sign-in page in your browser.');
  const { state } = vi.mocked(startServiceConnection).mock.calls[0]![2];
  expect(cancelServiceConnection).toHaveBeenCalledWith(server, 'example', state);
});

it('expires the local secret after ten minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { id, url } = await start();
  expect((await fetch(url + `?state=${id}&code=SYNTHETIC`)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(600_000);
  await expect(getServiceBrowserFlow(server, 'example', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
  expect(getServiceFlow).not.toHaveBeenCalled();
});

/** Something else holding `port` on loopback, as another app might. */
async function occupy(port: number): Promise<Server> {
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', resolve));
  return other;
}

it('listens on the first free port of those the vendor takes a sign-in back on', async () => {
  const busy = await occupy(43871);
  try {
    vi.mocked(getConnectionCatalog).mockResolvedValue(listed([43871, 43872]));
    const { id, input, url } = await start();
    expect(input.port).toBe(43872);
    expect((await fetch(url + `?state=${id}&code=SYNTHETIC`)).status).toBe(200);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

it('says which ports to free when every one is taken, and starts nothing', async () => {
  const busy = await occupy(43873);
  try {
    vi.mocked(getConnectionCatalog).mockResolvedValue(listed([43873]));
    await expect(startServiceBrowserFlow(server, 'example', {}, vi.fn())).rejects.toThrow(
      'Example takes a sign-in back only on port 43873 of this computer, and all are in use.'
    );
    expect(startServiceConnection).not.toHaveBeenCalled();
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});
