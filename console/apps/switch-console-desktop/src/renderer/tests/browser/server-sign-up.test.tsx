/**
 * A server that allows sign-up offers Create account beside sign-in. The form
 * checks what it can before sending — every field filled, the passwords
 * matching — shows the server's own refusal when it says no, and on success
 * hands on exactly as a sign-in does, with the new machine's status.
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
  signup: vi.fn(),
  passwordLogin: vi.fn(),
  ensureCloudMachine: vi.fn(),
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
  type SignedIn,
  ServerSignInFields,
  useServerSignIn,
} from '@renderer/features/switch-servers/server-sign-in';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';

const CLOUD_ORIGIN = 'https://cloud.example.com';
const SERVER: SwitchServer = {
  id: 'server',
  name: 'Switch',
  gatewayUrl: CLOUD_ORIGIN,
  apiUrl: CLOUD_ORIGIN,
} as SwitchServer;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  switchServers.switchCloud.mockResolvedValue({ url: CLOUD_ORIGIN });
  runInAction(() => {
    switchServersStore.servers = [SERVER];
    switchServersStore.authConfigs.clear();
  });
  switchServers.getAuthConfig.mockResolvedValue({
    passwordLoginEnabled: true,
    oidcEnabled: false,
    oidcProviderLabel: null,
    signupEnabled: true,
  });
  switchServers.getConnectionStatus.mockResolvedValue({
    serverId: 'server',
    connected: true,
    user: null,
  });
  switchServers.ensureCloudMachine.mockResolvedValue({});
  featureFlags.current.mockResolvedValue(hostedAgents(true));
});

function hostedAgents(enabled: boolean) {
  return { success: true, data: { flags: { hosted_agents: enabled } } };
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const Harness = observer(function Harness({
  onSignedIn,
}: {
  onSignedIn: (signedIn: SignedIn) => void;
}) {
  const signIn = useServerSignIn('server');
  return (
    <ServerSignInFields
      signIn={signIn}
      idPrefix="test"
      onSignedIn={onSignedIn}
      passwordSubmit={
        <button
          type="button"
          data-testid="submit"
          disabled={!signIn.canSubmitForm}
          onClick={() =>
            void signIn.submitForm().then((signedIn) => signedIn && onSignedIn(signedIn))
          }
        >
          {signIn.submitLabel}
        </button>
      }
    />
  );
});

async function render(onSignedIn: (signedIn: SignedIn) => void): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness onSignedIn={onSignedIn} />));
  await vi.waitFor(() => expect(container!.textContent).toContain('Create account'));
  return container;
}

function buttonNamed(el: HTMLElement, name: string): HTMLButtonElement {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!button) throw new Error(`No button named ${name}`);
  return button;
}

async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openCreateAccount(el: HTMLElement): Promise<void> {
  await act(async () => buttonNamed(el, 'Create account').click());
  expect(el.querySelector('#test-confirm-password')).not.toBeNull();
}

async function submit(el: HTMLElement): Promise<void> {
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="submit"]')!.click());
}

it('asks for every field before sending anything', async () => {
  const el = await render(() => {});
  await openCreateAccount(el);

  await submit(el);

  expect(el.textContent).toContain('Enter your email.');
  expect(el.textContent).toContain('Enter a password.');
  expect(el.textContent).toContain('Confirm your password.');
  expect(switchServers.signup).not.toHaveBeenCalled();
});

it('refuses passwords that do not match', async () => {
  const el = await render(() => {});
  await openCreateAccount(el);
  await type(el, 'test-email', 'ada@example.com');
  await type(el, 'test-password', 'correct-horse');
  await type(el, 'test-confirm-password', 'correct-horsf');

  await submit(el);

  expect(el.textContent).toContain('Passwords do not match.');
  expect(el.querySelector('#test-confirm-password')?.getAttribute('aria-invalid')).toBe('true');
  expect(switchServers.signup).not.toHaveBeenCalled();
});

it('shows the server’s refusal beside the form', async () => {
  switchServers.signup.mockResolvedValue({
    success: false,
    error: { kind: 'email_taken', message: 'Email already registered' },
  });
  const onSignedIn = vi.fn();
  const el = await render(onSignedIn);
  await openCreateAccount(el);
  await type(el, 'test-email', 'ada@example.com');
  await type(el, 'test-password', 'correct-horse');
  await type(el, 'test-confirm-password', 'correct-horse');

  await submit(el);

  await vi.waitFor(() =>
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Email already registered')
  );
  expect(onSignedIn).not.toHaveBeenCalled();
});

it('shows the server’s sign-up cap as it words it', async () => {
  const message = 'Too many sign-ups on this server in the last hour. Try again later.';
  switchServers.signup.mockResolvedValue({
    success: false,
    error: { kind: 'rate_limited', message },
  });
  const onSignedIn = vi.fn();
  const el = await render(onSignedIn);
  await openCreateAccount(el);
  await type(el, 'test-email', 'ada@example.com');
  await type(el, 'test-password', 'correct-horse');
  await type(el, 'test-confirm-password', 'correct-horse');

  await submit(el);

  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toBe(message));
  expect(onSignedIn).not.toHaveBeenCalled();
});

it('signs up and hands on the machine status, without warming it twice', async () => {
  const machine = { status: 'unavailable', reason: 'No machine is free right now.' };
  switchServers.signup.mockResolvedValue({
    success: true,
    data: {
      user: { id: 'u1', name: 'ada', email: 'ada@example.com', role: 'user', server: null },
      machine,
    },
  });
  const onSignedIn = vi.fn();
  const el = await render(onSignedIn);
  await openCreateAccount(el);
  await type(el, 'test-email', ' ada@example.com ');
  await type(el, 'test-password', 'correct-horse');
  await type(el, 'test-confirm-password', 'correct-horse');

  await submit(el);

  await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ machine }));
  expect(switchServers.signup).toHaveBeenCalledWith({
    serverId: 'server',
    email: 'ada@example.com',
    password: 'correct-horse',
  });
  expect(switchServers.getConnectionStatus).toHaveBeenCalledWith('server');
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});

it('warms the cloud machine after signing in to Switch Cloud', async () => {
  switchServers.passwordLogin.mockResolvedValue({ success: true, data: {} });
  const onSignedIn = vi.fn();
  const el = await render(onSignedIn);
  await type(el, 'test-email', 'ada@example.com');
  await type(el, 'test-password', 'correct-horse');

  await submit(el);

  await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ machine: null }));
  await vi.waitFor(() => expect(switchServers.ensureCloudMachine).toHaveBeenCalledWith('server'));
});

it('leaves the cloud machine alone when Switch Cloud turns cloud machines off', async () => {
  featureFlags.current.mockResolvedValue(hostedAgents(false));
  switchServers.passwordLogin.mockResolvedValue({ success: true, data: {} });
  const onSignedIn = vi.fn();
  const el = await render(onSignedIn);
  await type(el, 'test-email', 'ada@example.com');
  await type(el, 'test-password', 'correct-horse');

  await submit(el);

  await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ machine: null }));
  await vi.waitFor(() => expect(featureFlags.current).toHaveBeenCalledWith('server'));
  expect(switchServers.ensureCloudMachine).not.toHaveBeenCalled();
});
