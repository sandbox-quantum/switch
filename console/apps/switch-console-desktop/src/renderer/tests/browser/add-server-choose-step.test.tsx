/**
 * The add-server chooser's Switch Cloud choice: offered while the Cloud is not
 * one of the servers yet, and not once it is.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

const state = vi.hoisted(() => ({ servers: [] as SwitchServer[] }));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/features/switch-servers/use-switch-cloud', () => ({
  useSwitchCloud: () => ({ kind: 'open', url: 'https://cloud.example.invalid' }),
}));

vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return state.servers;
    },
    connectToSwitchCloud: vi.fn(),
  },
}));

import { ChooseStep } from '@renderer/features/switch-servers/AddServerModal';
import { WizardChromeProvider } from '@renderer/lib/ui/wizard-frame';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function server(url: string): SwitchServer {
  return {
    id: url,
    name: url,
    gatewayUrl: url,
    apiUrl: url,
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '',
    updatedAt: '',
  };
}

async function render(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => {};
  await act(async () =>
    root!.render(
      // Drawn as a page, the way first run draws it, so it needs no dialog.
      <WizardChromeProvider chrome="page" exit={null}>
        <ChooseStep
          onLocal={noop}
          onRemoteHost={noop}
          onExternal={noop}
          onCloud={noop}
          onClose={noop}
        />
      </WizardChromeProvider>
    )
  );
  return document.body.textContent ?? '';
}

describe('the Switch Cloud choice', () => {
  it('is offered while Switch Cloud is not one of your servers', async () => {
    state.servers = [server('https://other.example.invalid')];
    expect(await render()).toContain('Connect to Switch Cloud');
  });

  it('is not offered once Switch Cloud is already added', async () => {
    state.servers = [server('https://cloud.example.invalid')];
    const text = await render();
    expect(text).not.toContain('Connect to Switch Cloud');
    expect(text).toContain('Connect to an existing server');
  });
});
