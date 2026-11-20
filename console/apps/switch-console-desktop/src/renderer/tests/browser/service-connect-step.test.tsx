/**
 * The generic sign-in step: it starts the sign-in at the vendor, waits for the
 * browser to finish, and shows the account connected once the server has kept
 * it, with no confirm in between. A refusal never strands the dialog: one the
 * server gives while connecting shows its reason and lets the dialog close,
 * and a cancel of a sign-in already gone is a cancel. A service that takes a
 * token or keys pasted in place of the sign-in offers each under it, on a
 * paste step that asks for the same site.
 */
import { type ReactNode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const switchServers = vi.hoisted(() => ({
  startServiceConnection: vi.fn(),
  getServiceFlow: vi.fn(),
  cancelServiceConnection: vi.fn(),
  connectServiceWithPaste: vi.fn(),
  disconnectService: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

import { serverServiceCalls } from '@renderer/features/switch-servers/service-calls';
import { ServiceConnectStep } from '@renderer/features/switch-servers/service-connect-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

const EXAMPLE: ConnectionCatalogEntry = {
  slug: 'example',
  name: 'Example',
  category: 'Development',
  description: 'Example access',
  enabled: true,
  auth_type: 'oauth',
  connectable: true,
  status: 'not_connected',
  unavailable_reason: null,
  unavailable_code: null,
  read_only_reason: null,
  pass_through: false,
  token_lifetime: null,
  agent_access_note: null,
  loopback_ports: null,
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
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(switchServers)) mock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(step: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>{step}</DialogContent>
      </Dialog>
    )
  );
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

function closable(): boolean {
  return dialog().querySelector('[data-slot="dialog-close"]') !== null;
}

function refusal(status: number, detail: string, retryable?: boolean): RpcError {
  return new RpcError(
    serializeRpcError(
      Object.assign(new Error(`Switch gateway returned ${status}`), {
        name: 'GatewayError',
        kind: 'http',
        status,
        detail,
        ...(retryable === undefined ? {} : { retryable }),
      })
    )
  );
}

function connectStep(
  onConnected: (warning: string | null) => void = () => {},
  connection: ConnectionCatalogEntry = EXAMPLE,
  startOn: 'token' | 'keys' | null = null
) {
  return (
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={connection}
      reconnecting={false}
      startOn={startOn}
      onBack={() => {}}
      onConnected={onConnected}
    />
  );
}

const SITES = ['datadoghq.com', 'datadoghq.eu', 'us5.datadoghq.com'];
const DATADOG: ConnectionCatalogEntry = {
  ...EXAMPLE,
  slug: 'datadog',
  name: 'Datadog',
  sign_in_choices: [
    {
      name: 'site',
      label: 'Datadog site',
      secret: false,
      help: 'The address you open Datadog at, without app.',
      choices: SITES,
    },
  ],
};

async function pick(label: string, choice: string) {
  await act(async () => dialog().querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === choice
  )!;
  await act(async () => option.click());
}

const CALLBACK = 'https://switch.example.test/gateway/service-connections/example/flows/callback';

/**
 * Starts a sign-in, returning to the server's `callbackUrl` where one is given;
 * the flow then reads whatever `getServiceFlow` answers.
 */
async function signIn(callbackUrl: string | null = null): Promise<void> {
  switchServers.startServiceConnection.mockResolvedValue({ id: 'flow-1', callbackUrl });
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  await act(async () => button(/^connect example/i, dialog())!.click());
  expect(switchServers.startServiceConnection).toHaveBeenCalledWith('server', 'example', {});
}

it('says what limits agent access before the sign-in starts', async () => {
  await render(
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={{
        ...EXAMPLE,
        agent_access_note: 'Agents have Example for the hour after each sign-in.',
      }}
      reconnecting={false}
      startOn={null}
      onBack={() => {}}
      onConnected={() => {}}
    />
  );

  expect(dialog().textContent).toContain('Agents have Example for the hour after each sign-in.');
});

it('says nothing more for a service without such a limit', async () => {
  await render(connectStep());

  expect([...dialog().querySelectorAll('p')].map((p) => p.textContent)).toEqual([
    'Example access',
    'You sign in at Example, and allow what Switch asks for. Agents you then turn Example on for act as you there.',
  ]);
});

it('still says what limits agent access once the service is connected', async () => {
  await render(
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={{
        ...EXAMPLE,
        status: 'connected',
        agent_access_note: 'Agents have Example for up to an hour after each sign-in.',
      }}
      reconnecting={false}
      startOn={null}
      onBack={() => {}}
      onConnected={() => {}}
    />
  );

  expect(dialog().textContent).toMatch(/Example connected/);
  expect(dialog().textContent).toContain(
    'Agents have Example for up to an hour after each sign-in.'
  );
});

it('asks for the site first, and signs in at the one picked', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  switchServers.startServiceConnection.mockResolvedValue({ id: 'flow-1', callbackUrl: null });
  await render(connectStep(() => {}, DATADOG));

  await vi.waitFor(() => expect(button(/^connect datadog/i, dialog())).toBeDefined());
  expect(dialog().textContent).toContain('The address you open Datadog at, without app.');
  // Nothing is picked yet, so the sign-in cannot start.
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(true);
  // The picker sits above the button that starts the sign-in.
  const picker = dialog().querySelector<HTMLElement>('[aria-label="Datadog site"]')!;
  const connect = button(/^connect datadog/i, dialog())!;
  expect(picker.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await pick('Datadog site', 'datadoghq.eu');
  expect(dialog().querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'datadoghq.eu'
  );
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(false);
  await act(async () => button(/^connect datadog/i, dialog())!.click());

  expect(switchServers.startServiceConnection).toHaveBeenCalledExactlyOnceWith(
    'server',
    'datadog',
    { site: 'datadoghq.eu' }
  );
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Finish signing in in your browser/));
  expect(dialog().querySelector('[aria-label="Datadog site"]')).toBeNull();
});

it('starts on the site the person connected at when they connect again', async () => {
  switchServers.startServiceConnection.mockResolvedValue({ id: 'flow-1', callbackUrl: null });
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  await render(
    connectStep(() => {}, {
      ...DATADOG,
      status: 'needs_reauthorization',
      choices: { site: 'us5.datadoghq.com' },
    })
  );

  await vi.waitFor(() => expect(button(/^connect datadog/i, dialog())!.disabled).toBe(false));
  expect(dialog().querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'us5.datadoghq.com'
  );
  await act(async () => button(/^connect datadog/i, dialog())!.click());
  expect(switchServers.startServiceConnection).toHaveBeenCalledWith('server', 'datadog', {
    site: 'us5.datadoghq.com',
  });
});

it('asks nothing first of a service whose sign-in takes no choice', async () => {
  await render(connectStep());
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  expect(dialog().querySelector('[data-slot="select-trigger"]')).toBeNull();
  expect(button(/^connect example/i, dialog())!.disabled).toBe(false);
});

it('connects through the sign-in as soon as the server has kept the account', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'connected',
    account: 'ada@example.test',
    error: null,
    warning: 'Access stays a while.',
  });
  const onConnected = vi.fn();
  await render(connectStep(onConnected));
  await signIn();

  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Example connected/));
  expect(onConnected).toHaveBeenCalledWith('Access stays a while.');
  expect(dialog().querySelector('[role="status"]')?.textContent).toBe('Access stays a while.');
  expect(button(/^disconnect$/i, dialog())).toBeDefined();
  expect(closable()).toBe(true);
});

it('waits on the browser, and cannot be closed meanwhile', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  await render(connectStep());
  await signIn();

  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Finish signing in in your browser/));
  expect(closable()).toBe(false);
  expect(button(/^cancel$/i, dialog())).toBeDefined();
  expect(dialog().textContent).not.toMatch(/allow-list/);
});

it('names the server’s callback to allow-list while a sign-in returns through it', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  await render(connectStep());
  await signIn(CALLBACK);

  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Finish signing in in your browser/));
  const hint = [...dialog().querySelectorAll('p')].find((p) =>
    p.textContent?.startsWith('If Example shows an error')
  );
  expect(hint?.textContent).toBe(
    `If Example shows an error, an admin must allow-list this URL at Example. ${CALLBACK}`
  );
});

it('suggests what to check once the browser has been away a minute', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    switchServers.getServiceFlow.mockResolvedValue({
      status: 'pending',
      account: null,
      error: null,
      warning: null,
    });
    await render(connectStep());
    await signIn();

    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(dialog().textContent).toMatch(/Finish signing in in your browser/);
    expect(dialog().textContent).not.toContain('showed an error');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(dialog().textContent).toContain(
      'If Example showed an error, cancel, and ask the person who set up Example for Switch to check its redirect URI and scopes.'
    );
    expect(button(/^cancel$/i, dialog())).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

it('waits a new minute for a sign-in started again after Cancel', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    switchServers.getServiceFlow.mockResolvedValue({
      status: 'pending',
      account: null,
      error: null,
      warning: null,
    });
    await render(connectStep());
    await signIn();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(dialog().textContent).toContain('showed an error');

    await act(async () => button(/^cancel$/i, dialog())!.click());
    switchServers.startServiceConnection.mockResolvedValue({ id: 'flow-2', callbackUrl: null });
    await act(async () => button(/^connect example/i, dialog())!.click());
    await act(async () => vi.advanceTimersByTimeAsync(59_000));
    expect(dialog().textContent).toMatch(/Finish signing in in your browser/);
    expect(dialog().textContent).not.toContain('showed an error');
  } finally {
    vi.useRealTimers();
  }
});

it('suggests nothing for a sign-in that came back before the minute', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    switchServers.getServiceFlow.mockResolvedValue({
      status: 'checking',
      account: null,
      error: null,
      warning: null,
    });
    await render(connectStep());
    await signIn();

    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(dialog().textContent).toMatch(/Connecting Example/);
    expect(dialog().textContent).not.toContain('showed an error');
  } finally {
    vi.useRealTimers();
  }
});

it("shows the server's reason when it refuses the account, and lets the dialog close", async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'failed',
    account: null,
    error:
      'This Example account is already linked to another Switch user in this workspace. Remove that link first.',
    warning: null,
  });
  const onConnected = vi.fn();
  await render(connectStep(onConnected));
  await signIn();

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      'already linked to another Switch user'
    )
  );
  expect(onConnected).not.toHaveBeenCalled();
  expect(closable()).toBe(true);
  expect(button(/^cancel$/i, dialog())).toBeDefined();
  // The browser has nothing left to finish.
  expect(dialog().textContent).not.toMatch(/Finish signing in/);
});

it('offers a new sign-in on a connected service when it is opened to reconnect', async () => {
  await render(
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={{ ...EXAMPLE, status: 'connected' }}
      reconnecting
      startOn={null}
      onBack={() => {}}
    />
  );

  expect(button(/^connect example/i, dialog())).toBeDefined();
  expect(dialog().textContent).toContain(
    'Signing in to another Example account replaces this one. Each agent then needs Example turned on again.'
  );
});

it('stops waiting on the browser once the vendor refused the sign-in', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'failed',
    account: null,
    error: 'Example refused the sign-in: Your identity provider refused this app.',
    warning: null,
  });
  await render(connectStep());
  await signIn();

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      'Example refused the sign-in: Your identity provider refused this app.'
    )
  );
  expect(dialog().textContent).not.toMatch(/Finish signing in in your browser/);
  expect(switchServers.getServiceFlow).toHaveBeenCalledOnce();
  expect(closable()).toBe(true);
});

it('counts a cancel of a sign-in the server already dropped as cancelled', async () => {
  switchServers.getServiceFlow.mockResolvedValue({
    status: 'pending',
    account: null,
    error: null,
    warning: null,
  });
  switchServers.cancelServiceConnection.mockRejectedValue(refusal(410, 'Sign-in not found.'));
  await render(connectStep());
  await signIn();

  await vi.waitFor(() => expect(button(/^cancel$/i, dialog())).toBeDefined());
  await act(async () => button(/^cancel$/i, dialog())!.click());
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(closable()).toBe(true);
});

const TOKEN = 'ddpat_ab12cd_SYNTHETICTOKENVALUE';
const PASTED_TOKEN = {
  method: 'token' as const,
  label: 'Personal access token',
  fields: [
    {
      name: 'pat',
      label: 'Personal access token',
      secret: true,
      help: 'Personal Settings, Access Tokens.',
      choices: null,
    },
  ],
  help_url: 'https://docs.datadoghq.com/account_management/personal-access-tokens/',
  expires: 'vendor' as const,
  access_note: 'Reaches what your token allows.',
};
const PASTED_KEYS = {
  method: 'keys' as const,
  label: 'API and application keys',
  fields: [
    { name: 'api_key', label: 'API key', secret: true, help: null, choices: null },
    { name: 'application_key', label: 'Application key', secret: true, help: null, choices: null },
  ],
  help_url: 'https://docs.datadoghq.com/account_management/api-app-keys/',
  expires: 'never' as const,
  access_note: 'Reaches what your keys allow.',
};
const PASTABLE: ConnectionCatalogEntry = {
  ...DATADOG,
  token_lifetime: 3600,
  paste: [PASTED_TOKEN, PASTED_KEYS],
};

function link(text: string): HTMLButtonElement | undefined {
  return button(new RegExp(`^${text}$`), dialog());
}

function input(label: string): HTMLInputElement {
  const id = [...dialog().querySelectorAll('label')].find((l) => l.textContent === label)!.htmlFor;
  return dialog().querySelector<HTMLInputElement>(`#${id}`)!;
}

async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('offers a token and keys under the sign-in, each with how long it lasts', async () => {
  await render(connectStep(() => {}, PASTABLE));

  await vi.waitFor(() => expect(link('Use a token instead')).toBeDefined());
  expect(link('Use API keys instead')).toBeDefined();
  expect(dialog().textContent).toContain('Expires: 1 hour, refreshed by Switch');

  await act(async () => link('Use API keys instead')!.click());
  expect(input('API key').type).toBe('password');
  expect(input('Application key').type).toBe('password');
  expect(dialog().textContent).toContain('Never expires; only Datadog can revoke it');
  expect(dialog().textContent).toContain('Reaches what your keys allow.');
  expect(button(/How to make keys in Datadog/, dialog())).toBeDefined();
});

it('offers only the ways to paste the server lists', async () => {
  await render(connectStep(() => {}, { ...PASTABLE, paste: [PASTED_TOKEN] }));

  await vi.waitFor(() => expect(link('Use a token instead')).toBeDefined());
  expect(link('Use API keys instead')).toBeUndefined();
});

it('pastes a token at the site picked, and is connected once the server keeps it', async () => {
  switchServers.connectServiceWithPaste.mockResolvedValue({
    warning: null,
    external_identity: 'ada@example.test',
    method: 'token',
    choices: { site: 'datadoghq.eu' },
  });
  const onConnected = vi.fn();
  await render(connectStep(onConnected, PASTABLE));
  await vi.waitFor(() => expect(link('Use a token instead')).toBeDefined());
  await act(async () => link('Use a token instead')!.click());

  // The site picker sits above what is pasted, as it does above the sign-in.
  const picker = dialog().querySelector<HTMLElement>('[aria-label="Datadog site"]')!;
  expect(
    picker.compareDocumentPosition(input('Personal access token')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(input('Personal access token').type).toBe('password');
  expect(dialog().textContent).toContain('Personal Settings, Access Tokens.');
  expect(dialog().textContent).toContain('Expires: on the date you set in Datadog');
  expect(dialog().textContent).toContain('Reaches what your token allows.');
  expect(dialog().textContent).not.toContain('Expires: 1 hour');
  expect(button(/How to make a token in Datadog/, dialog())).toBeDefined();
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(true);

  await type(input('Personal access token'), `  ${TOKEN} `);
  // Nothing is sent before the site is picked too.
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(true);
  await pick('Datadog site', 'datadoghq.eu');
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(false);
  await act(async () => button(/^connect datadog/i, dialog())!.click());

  expect(switchServers.connectServiceWithPaste).toHaveBeenCalledExactlyOnceWith(
    'server',
    'datadog',
    { method: 'token', fields: { pat: TOKEN }, choices: { site: 'datadoghq.eu' } }
  );
  expect(switchServers.startServiceConnection).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Datadog connected/));
  expect(onConnected).toHaveBeenCalledWith(null);
  expect(dialog().textContent).toContain('Reaches what your token allows.');
  expect(dialog().innerHTML).not.toContain(TOKEN);
});

it('goes back to the sign-in from the paste step, with the site still picked', async () => {
  await render(connectStep(() => {}, PASTABLE));
  await vi.waitFor(() => expect(link('Use a token instead')).toBeDefined());
  await act(async () => link('Use a token instead')!.click());
  await pick('Datadog site', 'us5.datadoghq.com');

  await act(async () => button(/^back$/i, dialog())!.click());

  expect(dialog().querySelector('label[for^="service-key-"]')).toBeNull();
  expect(link('Use a token instead')).toBeDefined();
  expect(dialog().querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'us5.datadoghq.com'
  );
  expect(button(/^connect datadog/i, dialog())!.disabled).toBe(false);
});

it('forgets a typed token once the person goes back from the paste step', async () => {
  await render(connectStep(() => {}, PASTABLE));
  await vi.waitFor(() => expect(link('Use a token instead')).toBeDefined());
  await act(async () => link('Use a token instead')!.click());
  await type(input('Personal access token'), TOKEN);

  await act(async () => button(/^back$/i, dialog())!.click());
  await act(async () => link('Use a token instead')!.click());

  expect(input('Personal access token').value).toBe('');
});

it('shows Switch’s refusal of what was pasted, on the paste step, with it cleared', async () => {
  switchServers.connectServiceWithPaste.mockRejectedValue(
    refusal(422, 'Datadog refused the pasted token, which may be wrong, revoked or expired.')
  );
  const onConnected = vi.fn();
  await render(
    connectStep(onConnected, { ...PASTABLE, choices: { site: 'datadoghq.com' } }, 'token')
  );
  await vi.waitFor(() => expect(input('Personal access token')).toBeDefined());
  await type(input('Personal access token'), TOKEN);
  await act(async () => button(/^connect datadog/i, dialog())!.click());

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      'Datadog refused the pasted token, which may be wrong, revoked or expired.'
    )
  );
  expect(onConnected).not.toHaveBeenCalled();
  expect(input('Personal access token').value).toBe('');
  expect(closable()).toBe(true);
});

it('opens on the paste step to paste a new token in place of one Datadog refused', async () => {
  await render(
    connectStep(
      () => {},
      {
        ...PASTABLE,
        status: 'needs_reauthorization',
        method: 'token',
        choices: { site: 'datadoghq.eu' },
        reconnect_code: 'token_refused',
        reconnect_reason: 'Datadog refused the pasted token. Paste a new one.',
      },
      'token'
    )
  );

  await vi.waitFor(() => expect(input('Personal access token')).toBeDefined());
  expect(dialog().querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'datadoghq.eu'
  );
  await act(async () => button(/^back$/i, dialog())!.click());
  expect(dialog().textContent).toContain('Datadog refused the pasted token. Paste a new one.');
});
