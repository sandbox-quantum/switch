import { afterEach, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelServiceConnection,
  completeServiceConnection,
  confirmServiceConnection,
  startServiceConnection,
} from './gateway-client';
import {
  cancelServiceBrowserFlow,
  confirmServiceBrowserFlow,
  getServiceBrowserFlow,
  startServiceBrowserFlow,
} from './service-browser-flow';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./gateway-client', () => ({
  cancelServiceConnection: vi.fn(),
  completeServiceConnection: vi.fn(),
  confirmServiceConnection: vi.fn(),
  getServiceFlow: vi.fn(),
  startServiceConnection: vi.fn(),
}));
const server = { id: 'server', gatewayUrl: 'https://switch.example.test' } as SwitchServer;
const flows: [string, string][] = [];
afterEach(async () => {
  for (const [service, id] of flows.splice(0)) await cancelServiceBrowserFlow(server, service, id);
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function start(service = 'example') {
  vi.mocked(completeServiceConnection).mockResolvedValue(undefined);
  vi.mocked(startServiceConnection).mockImplementation(async (_server, _service, input) => ({
    id: input.state,
    url: 'https://auth.example.test/authorize',
    mode: 'loopback',
  }));
  const open = vi.fn().mockResolvedValue(undefined);
  const id = await startServiceBrowserFlow(server, service, open);
  flows.push([service, id]);
  const input = vi.mocked(startServiceConnection).mock.calls[0]![2];
  return { id, input, open, url: `http://127.0.0.1:${input.port}/switch-services/callback` };
}

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
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(200);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toContain('Return to Switch Console');
  expect(completeServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    'SYNTHETIC',
    input.completion_secret
  );
  await confirmServiceBrowserFlow(server, 'example', id);
  expect(confirmServiceConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    'example',
    id,
    input.completion_secret
  );
});

it('keys each flow by its service', async () => {
  const { id } = await start('example');
  await expect(confirmServiceBrowserFlow(server, 'other', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
  expect(confirmServiceConnection).not.toHaveBeenCalled();
});

it('does not show Core’s failure in the browser, and ends the flow', async () => {
  const { id, url } = await start();
  vi.mocked(completeServiceConnection).mockRejectedValue(new Error('Private server detail'));
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('Private server detail');
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

it('cancels the server flow if the browser cannot open', async () => {
  vi.mocked(startServiceConnection).mockImplementation(async (_server, _service, input) => ({
    id: input.state,
    url: 'https://auth.example.test/authorize',
    mode: 'loopback',
  }));
  await expect(
    startServiceBrowserFlow(server, 'example', async () => {
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
  await expect(confirmServiceBrowserFlow(server, 'example', id)).rejects.toThrow(
    'Sign-in was interrupted'
  );
  expect(confirmServiceConnection).not.toHaveBeenCalled();
});
