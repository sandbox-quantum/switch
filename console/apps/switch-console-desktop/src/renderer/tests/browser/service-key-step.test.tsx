/**
 * Connecting a service with a key: a form built from the catalog entry, the
 * keys typed into password inputs and cleared once sent, the server's refusal
 * shown as it said it, and a connected key shown by whose it is. Opened to
 * replace a connected key, it opens on the form and ends on Done.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import { RpcError, serializeRpcError } from '@shared/lib/ipc/rpc-error';

const switchServers = vi.hoisted(() => ({
  startServiceConnection: vi.fn(),
  connectServiceWithKey: vi.fn(),
  disconnectService: vi.fn(),
}));
const openExternalUrl = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { switchServers },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useModalContext: () => ({ setCloseGuard: () => {} }),
}));

vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }));

import { serverServiceCalls } from '@renderer/features/switch-servers/service-calls';
import { ServiceKeyStep } from '@renderer/features/switch-servers/service-key-step';
import { Dialog, DialogContent } from '@renderer/lib/ui/dialog';

const API_KEY = 'synthetic-datadog-api-key';
const APP_KEY = 'synthetic-datadog-application-key';

/** A service connected with a key, as the catalog describes Datadog's. */
function keyed(status: ConnectionCatalogEntry['status']): ConnectionCatalogEntry {
  return {
    slug: 'datadog',
    name: 'Datadog',
    category: 'Observability',
    description: 'Datadog access',
    enabled: true,
    auth_type: 'api_key',
    connectable: true,
    status,
    unavailable_reason: null,
    unavailable_code: null,
    read_only_reason: null,
    pass_through: true,
    token_lifetime: 3600,
    loopback_ports: null,
    external_identity: status === 'connected' ? 'Datadog key · datadoghq.eu' : null,
    consent: null,
    workspace_enabled: null,
    key: {
      fields: [
        {
          name: 'api_key',
          label: 'API key',
          secret: true,
          help: 'Organization Settings, API Keys.',
          choices: null,
        },
        {
          name: 'application_key',
          label: 'Application key',
          secret: true,
          help: 'Personal Settings, Application Keys.',
          choices: null,
        },
        {
          name: 'site',
          label: 'Datadog site',
          secret: false,
          help: 'The address you open Datadog at.',
          choices: ['datadoghq.com', 'datadoghq.eu'],
        },
      ],
      help_url: 'https://docs.datadoghq.com/account_management/api-app-keys/',
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  for (const mock of Object.values(switchServers)) mock.mockReset();
  openExternalUrl.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(
  status: ConnectionCatalogEntry['status'] = 'not_connected',
  replacing = false,
  onBack: () => void = () => {}
): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const connection = keyed(status);
  await act(async () =>
    root!.render(
      <Dialog open>
        <DialogContent>
          <ServiceKeyStep
            calls={serverServiceCalls('server')}
            connection={connection}
            form={connection.key!}
            replacing={replacing}
            onBack={onBack}
            onConnected={() => {}}
          />
        </DialogContent>
      </Dialog>
    )
  );
  await vi.waitFor(() =>
    expect(dialog().textContent).toMatch(
      /Connect Datadog|Datadog connected|Replace the Datadog key/
    )
  );
  return dialog();
}

function button(name: RegExp, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
}

function input(within: ParentNode, label: string): HTMLInputElement {
  const id = [...within.querySelectorAll('label')].find((l) => l.textContent === label)!.htmlFor;
  return within.querySelector<HTMLInputElement>(`#${id}`)!;
}

async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pick(within: ParentNode, label: string, choice: string) {
  await act(async () => within.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click());
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === choice
  )!;
  await act(async () => option.click());
}

async function fillKey(step: HTMLElement) {
  await type(input(step, 'API key'), API_KEY);
  await type(input(step, 'Application key'), APP_KEY);
  await pick(step, 'Datadog site', 'datadoghq.eu');
}

it('is a form built from the catalog entry, not the sign-in', async () => {
  const step = await render();

  expect(step.textContent).toMatch(/Connect Datadog/);
  expect(input(step, 'API key').type).toBe('password');
  expect(input(step, 'Application key').type).toBe('password');
  expect(step.querySelector('[aria-label="Datadog site"]')).not.toBeNull();
  expect(step.textContent).toContain('Organization Settings, API Keys.');
  expect(step.textContent).toContain('The address you open Datadog at.');
  expect(step.textContent).toContain(
    "Switch checks the key with Datadog, stores it encrypted, and never shows it again. The agent can do whatever this key allows. Keys don't expire; disconnecting removes the key from Switch but can't revoke it at Datadog — revoke it there too."
  );
  expect(switchServers.startServiceConnection).not.toHaveBeenCalled();
  await act(async () => button(/How to make a Datadog key/, step)!.click());
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://docs.datadoghq.com/account_management/api-app-keys/',
    expect.any(String)
  );
  expect(button(/^connect datadog$/i, step)?.disabled).toBe(true);
});

it('connects with the fields typed and picked, and shows whose key it is', async () => {
  switchServers.connectServiceWithKey.mockResolvedValue({
    warning: null,
    external_identity: 'Datadog key · datadoghq.eu',
  });
  switchServers.disconnectService.mockResolvedValue({
    warning: 'Switch has forgotten the Datadog key but cannot revoke it.',
  });
  const step = await render();
  await fillKey(step);

  await vi.waitFor(() => expect(button(/^connect datadog$/i, step)?.disabled).toBe(false));
  await act(async () => button(/^connect datadog$/i, step)!.click());
  expect(switchServers.connectServiceWithKey).toHaveBeenCalledWith('server', 'datadog', {
    api_key: API_KEY,
    application_key: APP_KEY,
    site: 'datadoghq.eu',
  });
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Datadog connected/));
  expect(dialog().textContent).toContain('Connected with Datadog key · datadoghq.eu');
  expect(dialog().innerHTML).not.toContain(API_KEY);
  expect(dialog().innerHTML).not.toContain(APP_KEY);

  await act(async () => button(/^replace key$/i, dialog())!.click());
  expect(input(dialog(), 'API key').value).toBe('');
  expect(input(dialog(), 'Application key').value).toBe('');

  await act(async () => button(/^disconnect$/i, dialog())!.click());
  expect(switchServers.disconnectService).toHaveBeenCalledWith('server', 'datadog');
  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe(
      'Switch has forgotten the Datadog key but cannot revoke it.'
    )
  );
  expect(dialog().textContent).toMatch(/Connect Datadog/);
});

it('shows Switch’s refusal of a key, and clears the keys typed', async () => {
  switchServers.connectServiceWithKey.mockRejectedValue(
    new RpcError(
      serializeRpcError(
        Object.assign(new Error('Switch gateway returned 422'), {
          name: 'GatewayError',
          kind: 'http',
          status: 422,
          detail: 'Datadog refused the key (HTTP 403). Check that it is right.',
        })
      )
    )
  );
  const step = await render();
  await fillKey(step);
  await act(async () => button(/^connect datadog$/i, step)!.click());

  await vi.waitFor(() =>
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      'Datadog refused the key (HTTP 403). Check that it is right.'
    )
  );
  expect(input(dialog(), 'API key').value).toBe('');
  expect(input(dialog(), 'Application key').value).toBe('');
  expect(dialog().querySelector('[aria-label="Datadog site"]')?.textContent).toContain(
    'datadoghq.eu'
  );
  expect(dialog().textContent).toMatch(/Connect Datadog/);
});

it('shows a connected key service as connected, with whose key it is', async () => {
  const step = await render('connected');
  expect(step.textContent).toMatch(/Datadog connected/);
  expect(step.textContent).toContain('Connected with Datadog key · datadoghq.eu');
  expect(button(/^disconnect$/i, step)).toBeDefined();
  expect(step.querySelector('[aria-label="Datadog key"]')).toBeNull();
});

it('opened to replace a key, opens on the form and ends on Done', async () => {
  switchServers.connectServiceWithKey.mockResolvedValue({
    warning: null,
    external_identity: 'Datadog key · datadoghq.com',
  });
  const onBack = vi.fn();
  const step = await render('connected', true, onBack);

  expect(step.textContent).toMatch(/Replace the Datadog key/);
  expect(step.querySelector('[aria-label="Datadog key"]')).not.toBeNull();
  expect(button(/^disconnect$/i, step)).toBeUndefined();
  await type(input(step, 'API key'), API_KEY);
  await type(input(step, 'Application key'), APP_KEY);
  await pick(step, 'Datadog site', 'datadoghq.com');
  await vi.waitFor(() => expect(button(/^replace key$/i, step)?.disabled).toBe(false));
  await act(async () => button(/^replace key$/i, step)!.click());

  expect(switchServers.connectServiceWithKey).toHaveBeenCalledWith('server', 'datadog', {
    api_key: API_KEY,
    application_key: APP_KEY,
    site: 'datadoghq.com',
  });
  await vi.waitFor(() => expect(dialog().textContent).toMatch(/Datadog connected/));
  expect(dialog().textContent).toContain('Connected with Datadog key · datadoghq.com');
  expect(dialog().innerHTML).not.toContain(API_KEY);
  expect(button(/^replace key$/i, dialog())).toBeUndefined();
  await act(async () => button(/^done$/i, dialog())!.click());
  expect(onBack).toHaveBeenCalledOnce();
});
