import { afterEach, expect, it, vi } from 'vitest';
import { focusMainWindow } from '@main/app/window';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  cancelGitHubConnection,
  completeGitHubConnection,
  getGitHubFlow,
  startGitHubConnection,
} from './gateway-client';
import {
  startGitHubBrowserFlow,
  cancelGitHubBrowserFlow,
  getGitHubBrowserFlow,
} from './github-browser-flow';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('@main/app/window', () => ({ focusMainWindow: vi.fn() }));
vi.mock('./gateway-client', () => ({
  cancelGitHubConnection: vi.fn(),
  completeGitHubConnection: vi.fn(),
  getGitHubFlow: vi.fn(),
  startGitHubConnection: vi.fn(),
}));
const server = { id: 'server', url: 'https://switch.example.test' } as SwitchServer;
const flows: string[] = [];
afterEach(async () => {
  for (const id of flows.splice(0)) await cancelGitHubBrowserFlow(server, id);
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function start() {
  vi.mocked(cancelGitHubConnection).mockResolvedValue(undefined);
  vi.mocked(completeGitHubConnection).mockResolvedValue({ warning: null, login: 'example-user' });
  vi.mocked(startGitHubConnection).mockImplementation(async (_server, input) => ({
    id: input.state,
    url: 'https://switch.example.test/authorize',
  }));
  const open = vi.fn().mockResolvedValue(undefined);
  const id = await startGitHubBrowserFlow(server, open);
  flows.push(id);
  const input = vi.mocked(startGitHubConnection).mock.calls[0]![1];
  return { id, input, open, url: `http://127.0.0.1:${input.port}/switch-github/callback` };
}

it('accepts only this Console state and keeps its secret out of the browser URL', async () => {
  const { id, input, open, url } = await start();
  expect(open.mock.calls[0]![0]).not.toContain(input.completion_secret);
  expect((await fetch(url + '?state=unknown&code=SYNTHETIC')).status).toBe(400);
  expect(completeGitHubConnection).not.toHaveBeenCalled();
  expect(focusMainWindow).not.toHaveBeenCalled();
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(200);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toContain('Signed in to GitHub, and connected to Switch.');
  expect(focusMainWindow).toHaveBeenCalledOnce();
  expect(completeGitHubConnection).toHaveBeenCalledExactlyOnceWith(
    server,
    id,
    'SYNTHETIC',
    input.completion_secret
  );
});

it('ends the flow once it reads connected, and tells the server to drop it', async () => {
  const { id } = await start();
  vi.mocked(getGitHubFlow).mockResolvedValue({
    status: 'connected',
    login: 'example-user',
    error: null,
    warning: null,
  });
  expect((await getGitHubBrowserFlow(server, id)).login).toBe('example-user');
  expect(cancelGitHubConnection).toHaveBeenCalledWith(server, id);
  await expect(getGitHubBrowserFlow(server, id)).rejects.toThrow('Sign-in was interrupted');
});

it('refuses unknown local flows and displays a failed completion', async () => {
  await expect(getGitHubBrowserFlow(server, 'unknown')).rejects.toThrow(
    'Sign-in was interrupted. Start it again from Switch Console.'
  );
  const { id, url } = await start();
  vi.mocked(completeGitHubConnection).mockRejectedValue(new Error('Private server detail'));
  const response = await fetch(url + `?state=${id}&code=SYNTHETIC`);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('Private server detail');
  await expect(getGitHubBrowserFlow(server, id)).rejects.toThrow(
    'Sign-in was interrupted. Start it again from Switch Console.'
  );
});

it('closes the listener when the user cancels', async () => {
  const { id, url } = await start();
  await cancelGitHubBrowserFlow(server, id);
  await expect(fetch(url)).rejects.toThrow();
});

it('cancels the server flow if the browser cannot open', async () => {
  vi.mocked(startGitHubConnection).mockImplementation(async (_server, input) => ({
    id: input.state,
    url: 'https://switch.example.test/authorize',
  }));
  await expect(
    startGitHubBrowserFlow(server, async () => {
      throw new Error('Private shell detail');
    })
  ).rejects.toThrow('Could not open GitHub in your browser.');
  const { state } = vi.mocked(startGitHubConnection).mock.calls[0]![1];
  expect(cancelGitHubConnection).toHaveBeenCalledWith(server, state);
  await expect(getGitHubBrowserFlow(server, state)).rejects.toThrow('Sign-in was interrupted');
});

it('expires the local secret even after the callback was received', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { id, url } = await start();
  expect((await fetch(url + `?state=${id}&code=SYNTHETIC`)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(600_000);
  await expect(getGitHubBrowserFlow(server, id)).rejects.toThrow('Sign-in was interrupted');
  expect(getGitHubFlow).not.toHaveBeenCalled();
});
