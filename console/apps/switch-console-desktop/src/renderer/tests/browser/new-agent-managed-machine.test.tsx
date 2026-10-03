/**
 * The create form's word on where a new agent runs, on a server with agent
 * management: managed on the chosen machine, and a button to turn that machine
 * on when it cannot take one yet.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';

const embeddedEnable = vi.hoisted(() => vi.fn());
const hostEnable = vi.hoisted(() => vi.fn());
const modelCatalogue = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    embeddedController: { enable: embeddedEnable },
    hostControllers: { enable: hostEnable },
    agents: { modelCatalogue },
  },
}));

import {
  ManagedModelField,
  ManagedRunLocationNotice,
} from '@renderer/features/locations/components/add-agent-modal/managed-run-location-notice';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  embeddedEnable.mockReset().mockResolvedValue(undefined);
  hostEnable.mockReset().mockResolvedValue(undefined);
  modelCatalogue
    .mockReset()
    .mockResolvedValue({ kind: 'available', models: [{ id: 'opus', variants: [] }] });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  );
  return container;
}

function notice(machine: NewAgentMachine, sshHost: string | null, onEnabled = vi.fn()) {
  return (
    <ManagedRunLocationNotice
      machine={machine}
      label={sshHost ?? 'This computer'}
      sshHost={sshHost}
      serverId="server-1"
      workspaceId="workspace-1"
      onEnabled={onEnabled}
    />
  );
}

describe('where a new agent runs', () => {
  it('says the agent runs managed on the machine', async () => {
    const el = await render(
      notice(
        {
          management: true,
          target: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
          blocker: null,
          canEnable: false,
        },
        null
      )
    );
    expect(el.textContent).toMatch(/Runs as a managed agent on This computer \(machine “laptop”\)/);
    expect(el.querySelector('button')).toBeNull();
  });

  it('turns this computer on from the form, then looks again', async () => {
    const onEnabled = vi.fn();
    const el = await render(
      notice(
        { management: true, target: null, blocker: 'Turn it on first.', canEnable: true },
        null,
        onEnabled
      )
    );
    const button = el.querySelector('button')!;
    expect(button.textContent).toBe('Run managed agents on this computer');
    await act(async () => button.click());
    expect(embeddedEnable).toHaveBeenCalledWith({
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
    expect(hostEnable).not.toHaveBeenCalled();
    expect(onEnabled).toHaveBeenCalled();
  });

  it('makes an SSH host a machine from the form', async () => {
    const el = await render(
      notice(
        { management: true, target: null, blocker: 'Make it a machine.', canEnable: true },
        'box'
      )
    );
    await act(async () => el.querySelector('button')!.click());
    expect(hostEnable).toHaveBeenCalledWith({
      sshHost: 'box',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
  });

  it('says Console runs the agent on a server without agent management', async () => {
    const el = await render(notice({ management: false }, null));
    expect(el.textContent).toMatch(/so this Console runs the agent/);
  });
});

describe('the managed model field', () => {
  it('suggests the machine’s models and says what a managed agent does not carry', async () => {
    const onChange = vi.fn();
    const el = await render(
      <ManagedModelField
        providerId="claude"
        sshHost={null}
        dir="/work/pm"
        value=""
        onChange={onChange}
      />
    );
    await vi.waitFor(() => expect(el.querySelector('datalist option')).not.toBeNull());
    expect(el.querySelector('datalist option')!.getAttribute('value')).toBe('opus');
    expect(modelCatalogue).toHaveBeenCalledWith({
      providerId: 'claude',
      sshHost: null,
      dir: '/work/pm',
    });
    expect(el.textContent).toMatch(/don’t carry the reasoning effort/);
  });
});
