/**
 * The generic sign-in step: it starts the sign-in at the vendor, waits for the
 * browser to finish, and shows the account connected once the server has kept
 * it, with no confirm in between. A refusal never strands the dialog: one the
 * server gives while connecting shows its reason and lets the dialog close,
 * and a cancel of a sign-in already gone is a cancel.
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
  pass_through: false,
  token_lifetime: null,
  loopback_ports: null,
  key: null,
  external_identity: null,
  consent: null,
  workspace_enabled: null,
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

function connectStep(onConnected: (warning: string | null) => void = () => {}) {
  return (
    <ServiceConnectStep
      calls={serverServiceCalls('server')}
      connection={EXAMPLE}
      onBack={() => {}}
      onConnected={onConnected}
    />
  );
}

/** Starts a sign-in; the flow then reads whatever `getServiceFlow` answers. */
async function signIn(): Promise<void> {
  switchServers.startServiceConnection.mockResolvedValue('flow-1');
  await vi.waitFor(() => expect(button(/^connect example/i, dialog())).toBeDefined());
  await act(async () => button(/^connect example/i, dialog())!.click());
  expect(switchServers.startServiceConnection).toHaveBeenCalledWith('server', 'example');
}

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
