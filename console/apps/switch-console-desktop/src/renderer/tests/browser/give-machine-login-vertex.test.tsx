/**
 * Giving a machine a Claude login through Google Vertex AI: a service account
 * key, pasted or picked, which the form recommends, or this computer's own
 * Google sign-in, which it warns gives the machine all of the user's Google
 * Cloud access.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const giveMachineLogin = vi.hoisted(() => vi.fn());
const machineLoginOutcome = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { managedAgents: { giveMachineLogin, machineLoginOutcome } },
  events: { on: () => () => {}, emit: () => {} },
}));

import {
  GiveMachineLogin,
  loginKindsFor,
} from '@renderer/features/locations/components/add-agent-modal/give-machine-login';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import '@renderer/index.css';

const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'a@b.iam.gserviceaccount.com',
});

const MACHINE: OwnedMachine = {
  id: 'controller-1',
  name: 'cloud-box',
  kind: 'ec2',
  state: 'online',
  providers: [],
  acceptsLogins: true,
  cloud: true,
  workspacesDir: null,
  local: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  giveMachineLogin.mockReset().mockResolvedValue({ operationId: 'op-1' });
  machineLoginOutcome.mockReset().mockResolvedValue({ state: 'succeeded' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <GiveMachineLogin
          serverId="server-1"
          machine={MACHINE}
          provider="claude"
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
}

function byLabel<T extends HTMLElement>(el: HTMLElement, label: string): T {
  const found = el.querySelector<T>(`[aria-label="${label}"]`);
  expect(found, `nothing labelled ${label}`).not.toBeNull();
  return found!;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );
  expect(found, `no ${text} button`).toBeDefined();
  return found!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
  await settle();
}

/** Types into a React-controlled field: sets the value as the browser would, then fires input. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseVertex(el: HTMLElement): Promise<void> {
  await click(byLabel(el, 'Vertex AI'));
}

describe('giving a machine a Claude login through Vertex AI', () => {
  it('offers Vertex AI as a third Claude login', () => {
    expect(loginKindsFor('claude').map((kind) => kind.label)).toEqual([
      'Setup token',
      'API key',
      'Vertex AI',
    ]);
    expect(loginKindsFor('codex').map((kind) => kind.value)).not.toContain('vertex');
  });

  it('recommends a service account key, and sends a pasted one with the project and region', async () => {
    const el = await render();
    await chooseVertex(el);

    expect(byLabel(el, 'Service account key (recommended)').getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(el.textContent).toContain('roles/aiplatform.user');
    expect(el.textContent).not.toContain('all of your Google Cloud access');
    expect(byLabel<HTMLInputElement>(el, 'Google Cloud project').value).toBe('cg-vertexai');
    expect(byLabel<HTMLInputElement>(el, 'Region').value).toBe('global');
    expect(button(el, 'Give login').disabled).toBe(true);

    await type(byLabel<HTMLTextAreaElement>(el, 'Service account key'), KEY);
    await type(byLabel<HTMLInputElement>(el, 'Region'), 'us-east5');
    await click(button(el, 'Give login'));

    expect(giveMachineLogin).toHaveBeenCalledWith({
      serverId: 'server-1',
      machineId: 'controller-1',
      provider: 'claude',
      login: {
        source: 'vertex',
        project: 'cg-vertexai',
        region: 'us-east5',
        credentials: { from: 'key', json: KEY },
      },
    });
    expect(el.textContent).toContain('Claude Code signs in on cloud-box.');
  });

  it('reads a picked key file', async () => {
    const el = await render();
    await chooseVertex(el);

    const input = byLabel<HTMLInputElement>(el, 'Service account key file');
    const files = new DataTransfer();
    files.items.add(new File([KEY], 'vertex-sa.json', { type: 'application/json' }));
    await act(async () => {
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await vi.waitFor(async () => {
      await settle();
      expect(byLabel<HTMLTextAreaElement>(el, 'Service account key').value).toBe(KEY);
    });
    expect(el.textContent).toContain('Read vertex-sa.json');
    await click(button(el, 'Give login'));
    expect(giveMachineLogin.mock.calls[0]![0].login.credentials).toEqual({
      from: 'key',
      json: KEY,
    });
  });

  it("warns that this computer's Google sign-in gives all of the user's access, and sends it", async () => {
    const el = await render();
    await chooseVertex(el);
    await click(byLabel(el, "This computer's Google sign-in"));

    expect(el.querySelector('[role="note"]')?.textContent).toContain(
      'This gives cloud-box all of your Google Cloud access'
    );
    expect(el.querySelector('[aria-label="Service account key"]')).toBeNull();
    expect(button(el, 'Give login').disabled).toBe(false);

    await click(button(el, 'Give login'));
    expect(giveMachineLogin.mock.calls[0]![0].login).toEqual({
      source: 'vertex',
      project: 'cg-vertexai',
      region: 'global',
      credentials: { from: 'this-computer' },
    });
  });

  it('shows why this computer has no Google sign-in to give', async () => {
    giveMachineLogin.mockRejectedValue(
      new Error(
        'This computer has no Google sign-in. Run `gcloud auth application-default login` on this computer first.'
      )
    );
    const el = await render();
    await chooseVertex(el);
    await click(byLabel(el, "This computer's Google sign-in"));
    await click(button(el, 'Give login'));

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Run `gcloud auth application-default login` on this computer first.'
    );
    expect(machineLoginOutcome).not.toHaveBeenCalled();
  });

  it('needs a project and a region', async () => {
    const el = await render();
    await chooseVertex(el);
    await click(byLabel(el, "This computer's Google sign-in"));
    await type(byLabel<HTMLInputElement>(el, 'Google Cloud project'), ' ');
    expect(button(el, 'Give login').disabled).toBe(true);
  });
});
