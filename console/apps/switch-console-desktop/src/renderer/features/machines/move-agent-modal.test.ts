import { Dialog, DialogContent } from '@switch-console/chat-ui/primitives/dialog';
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentView, OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { MoveAgentModal } from './move-agent-modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const update = vi.hoisted(() => vi.fn(async () => {}));
const owned = vi.hoisted(() => ({ machines: [] as OwnedMachine[] }));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { managedAgents: { update } },
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOwnedMachines: () => ({ data: owned.machines, error: null }),
}));

function device(id: string, patch: Partial<OwnedMachine> = {}): OwnedMachine {
  return {
    id,
    name: id,
    kind: 'daemon',
    state: 'online',
    providers: [{ provider: 'claude', ready: true, problem: null }],
    acceptsLogins: false,
    cloud: false,
    workspacesDir: null,
    os: null,
    lastSeenAt: null,
    local: null,
    ...patch,
  } as OwnedMachine;
}

const agent = {
  serverId: 's',
  agentId: 'a',
  name: 'helper',
  displayName: 'Helper',
  definition: { provider: 'claude', directory: '/work' },
  machine: { id: 'current', name: 'Current' },
  status: null,
} as unknown as ManagedAgentView;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  update.mockClear();
});

async function render(machines: OwnedMachine[], onSuccess = vi.fn()) {
  owned.machines = machines;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          Dialog,
          { open: true },
          createElement(
            DialogContent,
            null,
            createElement(MoveAgentModal, { agent, onSuccess, onClose: vi.fn() })
          )
        )
      )
    )
  );
  return document.body;
}

function row(view: HTMLElement, name: string): HTMLElement {
  const found = [...view.querySelectorAll<HTMLElement>('[role="radio"]')].find((each) =>
    each.textContent?.includes(name)
  );
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

async function pressConfirm() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true })
    );
  });
  await act(async () => await Promise.resolve());
}

describe('the Move dialog', () => {
  it('labels and draws each device by its kind', async () => {
    const view = await render([
      device('box', { local: { kind: 'ssh-host', sshHost: 'box.example.com' } }),
      device('cloudy', { kind: 'ec2', cloud: true }),
      device('desk', { kind: 'console' }),
      device('plain'),
      device('mine', { kind: 'console', local: { kind: 'this-computer' } }),
    ]);
    const cases = [
      ['box', 'SSH host', 'lucide-server'],
      ['cloudy', 'Switch Cloud', 'lucide-cloud'],
      ['desk', 'Computer', 'lucide-monitor'],
      ['plain', 'Standalone machine', 'lucide-server'],
      ['This computer', null, 'lucide-laptop'],
    ] as const;
    for (const [name, label, icon] of cases) {
      const each = row(view, name);
      if (label) expect(each.textContent).toContain(label);
      expect(each.querySelector(`svg.${icon}`)).not.toBeNull();
    }
  });

  it('moves once on the confirm hotkey after a device is picked, and not before', async () => {
    const onSuccess = vi.fn();
    const view = await render([device('target')], onSuccess);

    await pressConfirm();
    expect(update).not.toHaveBeenCalled();

    await act(async () => row(view, 'target').click());
    await pressConfirm();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      serverId: 's',
      agentId: 'a',
      changes: { definition: {}, machineId: 'target' },
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
