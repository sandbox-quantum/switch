// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeviceConsentAsk,
  DeviceConsentEvent,
} from '@shared/core/embedded-controller/embedded-controller';

const rpc = vi.hoisted(() => ({
  embeddedController: {
    allowForAgent: vi.fn(async () => {}),
    denyForAgent: vi.fn(async () => {}),
    revokeForAgent: vi.fn(async () => {}),
    consentAsks: vi.fn(async (): Promise<DeviceConsentEvent[]> => []),
    deviceGrants: vi.fn(async () => [
      { agentId: 'agent-1', bypass: true, directories: ['/srv/repo'] },
    ]),
  },
}));
const listeners = vi.hoisted(() => new Set<(event: DeviceConsentEvent) => void>());
const showModal = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/ipc', () => ({
  rpc,
  events: {
    on: (_channel: unknown, listener: (event: DeviceConsentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal,
  useShowModal: (id: string) => (args: unknown) => showModal(id, args),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    serverById: (id: string) =>
      id === 'srv' ? { name: 'Acme', url: 'https://switch.example.com' } : null,
  },
}));

const { DeviceConsentModal } = await import('@renderer/features/machines/device-consent-modal');
const { Dialog, DialogContent } = await import('@renderer/lib/ui/dialog');
const { DeviceConsentPrompts } = await import('@renderer/features/machines/device-consent-prompts');
const { DevicePermissionsCard } =
  await import('@renderer/features/machines/device-permissions-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ASK: DeviceConsentAsk = {
  agentId: 'agent-1',
  name: 'scout',
  displayName: 'Scout',
  bypass: true,
  directory: '/srv/repo',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const fn of Object.values(rpc.embeddedController)) fn.mockClear();
  showModal.mockReset();
  listeners.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client }, node)));
  // react-query delivers results on setTimeout(0), so flush macrotasks, not microtasks.
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`No button "${text}" in: ${document.body.textContent}`);
  return found;
}

/** The modal as the app shows it: inside an open dialog, drawn into the page's body. */
function inDialog(node: ReactElement): ReactElement {
  return createElement(Dialog, { open: true }, createElement(DialogContent, null, node));
}

describe('the ask', () => {
  it('names the agent, the server and what it would be allowed, and Allow allows it', async () => {
    const onSuccess = vi.fn();
    await render(
      inDialog(
        createElement(DeviceConsentModal, {
          serverId: 'srv',
          ask: ASK,
          onSuccess,
          onClose: vi.fn(),
        })
      )
    );
    const text = document.body.textContent ?? '';
    expect(document.body.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(
      'Allow scout from Acme (switch.example.com) on this computer?'
    );
    expect(text).toContain('scout (shown as “Scout”) asks to:');
    expect(text).toContain('Run every command without asking you first, as you, on this computer.');
    expect(text).toContain('Work in /srv/repo on this computer.');

    await act(async () => button('Allow').click());
    expect(rpc.embeddedController.allowForAgent).toHaveBeenCalledWith({
      serverId: 'srv',
      agentId: 'agent-1',
      choice: { bypass: true, directory: '/srv/repo' },
    });
    expect(rpc.embeddedController.denyForAgent).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('leads with the unique name, not a display name its owner set to pass for something else', async () => {
    await render(
      inDialog(
        createElement(DeviceConsentModal, {
          serverId: 'srv',
          ask: { ...ASK, displayName: 'IT Security Update' },
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      )
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Allow scout from Acme (switch.example.com) on this computer?');
    expect(text).not.toContain('Allow IT Security Update');
    expect(text).toContain('scout (shown as “IT Security Update”) asks to:');
  });

  it('says nothing about a display name that is the agent’s name', async () => {
    await render(
      inDialog(
        createElement(DeviceConsentModal, {
          serverId: 'srv',
          ask: { ...ASK, displayName: null },
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      )
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('scout asks to:');
    expect(text).not.toContain('shown as');
  });

  it('records a no without allowing anything', async () => {
    await render(
      inDialog(
        createElement(DeviceConsentModal, {
          serverId: 'srv',
          ask: { ...ASK, directory: null },
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      )
    );
    expect(document.body.textContent).not.toContain('Work in');
    await act(async () => button('Don’t allow').click());
    expect(rpc.embeddedController.denyForAgent).toHaveBeenCalledWith({
      serverId: 'srv',
      agentId: 'agent-1',
      choice: { bypass: true, directory: null },
    });
    expect(rpc.embeddedController.allowForAgent).not.toHaveBeenCalled();
  });
});

describe('putting asks to the person', () => {
  it('opens the ask once per ask: at start, and for a new one as it arrives', async () => {
    rpc.embeddedController.consentAsks.mockResolvedValueOnce([{ serverId: 'srv', asks: [ASK] }]);
    await render(createElement(DeviceConsentPrompts));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal).toHaveBeenCalledWith(
      'deviceConsentModal',
      expect.objectContaining({ serverId: 'srv', ask: ASK })
    );

    const emit = async (event: DeviceConsentEvent) => {
      await act(async () => {
        for (const listener of listeners) listener(event);
      });
    };
    await emit({ serverId: 'srv', asks: [ASK] });
    expect(showModal).toHaveBeenCalledTimes(1);
    const other = { ...ASK, bypass: false, directory: '/srv/other' };
    await emit({ serverId: 'srv', asks: [ASK, other] });
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(showModal).toHaveBeenLastCalledWith(
      'deviceConsentModal',
      expect.objectContaining({ ask: other })
    );
  });
});

describe('what this computer allows', () => {
  it('lists each agent’s grants with Revoke, which takes it back', async () => {
    await render(createElement(DevicePermissionsCard, { serverId: 'srv', agents: null }));
    const text = container.textContent ?? '';
    expect(text).toContain('Runs every command without asking you first');
    expect(text).toContain('Works in /srv/repo');
    const revokes = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent === 'Revoke'
    );
    expect(revokes).toHaveLength(2);
    await act(async () => revokes[1]!.click());
    expect(rpc.embeddedController.revokeForAgent).toHaveBeenCalledWith({
      serverId: 'srv',
      agentId: 'agent-1',
      choice: { bypass: false, directory: '/srv/repo' },
    });
  });
});
