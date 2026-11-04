/**
 * Hosted agents v2: signing in to any server with v2 on wakes the person's box
 * only when it was put away (retained), so Add agent can offer it. It never
 * makes a box. With v2 off, sign-in does exactly what upstream does.
 */
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const switchServers = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  getConnectionStatus: vi.fn(),
  passwordLogin: vi.fn(),
  ensureCloudMachine: vi.fn(),
  cloudMachines: vi.fn(),
  switchCloud: vi.fn(),
}));
const featureFlags = vi.hoisted(() => ({ current: vi.fn() }));
const workspaces = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  getActiveId: vi.fn(async () => null),
  serversWithoutMembership: vi.fn(async () => []),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers, workspaces, featureFlags },
}));

import {
  ServerSignInFields,
  useServerSignIn,
} from '@renderer/features/switch-servers/server-sign-in';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';

// A server joined by address, not Switch Cloud's own (slot-1's case).
const SERVER: SwitchServer = {
  id: 'server',
  name: 'Test server',
  url: 'https://joined.example.com',
  dashboardUrl: null,
} as SwitchServer;

const retainedBox = {
  machine_id: 'm1',
  backend: 'box',
  state: 'retained',
  desired_state: 'retained',
  stop_reason: 'idle',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function flags(on: Record<string, boolean>) {
  return { success: true, data: { flags: on } };
}

beforeEach(() => {
  vi.clearAllMocks();
  switchServers.switchCloud.mockResolvedValue({ url: 'https://cloud.example.com' });
  runInAction(() => {
    switchServersStore.servers = [SERVER];
    switchServersStore.authConfigs.clear();
  });
  switchServers.getAuthConfig.mockResolvedValue({
    passwordLoginEnabled: true,
    oidcEnabled: false,
    oidcProviderLabel: null,
    oidcLoginOptions: [],
    oidcBrowserHandoff: false,
    signupEnabled: false,
  });
  switchServers.getConnectionStatus.mockResolvedValue({
    serverId: 'server',
    connected: true,
    user: null,
  });
  switchServers.passwordLogin.mockResolvedValue({ success: true, data: {} });
  switchServers.ensureCloudMachine.mockResolvedValue({});
  switchServers.cloudMachines.mockResolvedValue([retainedBox]);
  featureFlags.current.mockResolvedValue(flags({ hosted_agents: true, hosted_v2: true }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const Harness = observer(function Harness({ onDone }: { onDone: (ok: boolean) => void }) {
  const signIn = useServerSignIn('server');
  return (
    <ServerSignInFields
      signIn={signIn}
      idPrefix="test"
      onSignedIn={() => {}}
      passwordSubmit={
        <button
          type="button"
          data-testid="submit"
          onClick={() => void signIn.signInWithPassword().then(onDone)}
        >
          Sign in
        </button>
      }
    />
  );
});

async function signIn(): Promise<void> {
  const onDone = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness onDone={onDone} />));
  await act(async () =>
    container!.querySelector<HTMLButtonElement>('[data-testid="submit"]')!.click()
  );
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
  await vi.waitFor(() => expect(featureFlags.current).toHaveBeenCalledWith('server'));
}

it('wakes a retained box on a joined v2 server', async () => {
  await signIn();
  await vi.waitFor(() => expect(switchServers.ensureCloudMachine).toHaveBeenCalledWith('server'));
});

it('leaves a box that is up alone', async () => {
  switchServers.cloudMachines.mockResolvedValue([
    { ...retainedBox, state: 'ready', desired_state: 'running' },
  ]);
  await signIn();
  await vi.waitFor(() => expect(switchServers.cloudMachines).toHaveBeenCalledWith('server'));
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});

it('leaves a box its owner stopped alone: the owner chose that', async () => {
  switchServers.cloudMachines.mockResolvedValue([
    { ...retainedBox, state: 'stopped', desired_state: 'stopped', stop_reason: 'owner' },
  ]);
  await signIn();
  await vi.waitFor(() => expect(switchServers.cloudMachines).toHaveBeenCalledWith('server'));
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});

it('never makes a box for someone who has none', async () => {
  switchServers.cloudMachines.mockResolvedValue([]);
  await signIn();
  await vi.waitFor(() => expect(switchServers.cloudMachines).toHaveBeenCalledWith('server'));
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});

it('with v2 off, a joined server is left alone, as upstream', async () => {
  featureFlags.current.mockResolvedValue(flags({ hosted_agents: true }));
  await signIn();
  expect(switchServers.cloudMachines).not.toHaveBeenCalled();
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});
