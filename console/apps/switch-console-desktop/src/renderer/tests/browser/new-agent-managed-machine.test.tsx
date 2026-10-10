/**
 * The create form's word on where a new agent runs, on a server with agent
 * management: managed on the chosen machine, a button to turn that machine on
 * when it cannot take one yet, and the providers the machine reports ready.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

const embeddedEnable = vi.hoisted(() => vi.fn());
const defaultWorkspace = vi.hoisted(() => vi.fn());
const hostEnable = vi.hoisted(() => vi.fn());
const modelCatalogue = vi.hoisted(() => vi.fn());
const advancedConfigSchema = vi.hoisted(() => vi.fn());
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
  events: { on: vi.fn() },
  rpc: {
    embeddedController: { enable: embeddedEnable, defaultWorkspace },
    hostControllers: { enable: hostEnable },
    agents: { modelCatalogue },
    managedAgents: { advancedConfigSchema, giveMachineLogin, machineLoginOutcome },
  },
}));

vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));

import { MachineProviderPicker } from '@renderer/features/locations/components/add-agent-modal/machine-provider-picker';
import {
  ManagedDirectoryField,
  useSuggestedManagedDirectory,
} from '@renderer/features/locations/components/add-agent-modal/managed-directory-field';
import {
  CanManageAgentsField,
  ManagedAdvancedConfig,
  ManagedRunLocationNotice,
} from '@renderer/features/locations/components/add-agent-modal/managed-run-location-notice';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  embeddedEnable.mockReset().mockResolvedValue(undefined);
  defaultWorkspace.mockReset().mockResolvedValue('/home/me/.switch/workspaces/pm-agent');
  hostEnable.mockReset().mockResolvedValue(undefined);
  modelCatalogue
    .mockReset()
    .mockResolvedValue({ kind: 'available', models: [{ id: 'opus', variants: [] }] });
  advancedConfigSchema.mockReset().mockResolvedValue({
    claude: [
      {
        key: 'effort',
        label: 'Effort',
        type: 'select',
        options: [
          { value: '', label: 'Inherit' },
          { value: 'high', label: 'high' },
        ],
      },
      { key: 'tools', label: 'Tools', type: 'list' },
    ],
  });
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

  it('sets this computer up for managed agents as soon as it is chosen, without asking', async () => {
    const onEnabled = vi.fn();
    await render(
      notice(
        { management: true, target: null, blocker: 'Turn it on first.', canEnable: true },
        null,
        onEnabled
      )
    );
    expect(embeddedEnable).toHaveBeenCalledTimes(1);
    expect(embeddedEnable).toHaveBeenCalledWith({
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
    expect(hostEnable).not.toHaveBeenCalled();
    expect(onEnabled).toHaveBeenCalled();
  });

  it('sets an SSH host up as a machine as soon as it is chosen', async () => {
    await render(
      notice(
        { management: true, target: null, blocker: 'Make it a machine.', canEnable: true },
        'box'
      )
    );
    expect(hostEnable).toHaveBeenCalledWith({
      sshHost: 'box',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
  });

  it('offers the button to try again when setting it up failed, and does not retry by itself', async () => {
    embeddedEnable.mockRejectedValueOnce(new Error('no controller'));
    const el = await render(
      notice(
        { management: true, target: null, blocker: 'Turn it on first.', canEnable: true },
        null
      )
    );
    expect(embeddedEnable).toHaveBeenCalledTimes(1);
    const button = el.querySelector('button')!;
    expect(button.textContent).toBe('Run managed agents on this computer');
    await act(async () => button.click());
    expect(embeddedEnable).toHaveBeenCalledTimes(2);
  });

  it('says Console runs the agent on a server without agent management', async () => {
    const el = await render(notice({ management: false }, null));
    expect(el.textContent).toMatch(/so this Console runs the agent/);
  });
});

/** Type into a controlled input the way React will notice. */
async function type(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a new managed agent’s advanced configuration', () => {
  it('shows the model first, then the server’s fields for the provider, and reports them as a definition takes them', async () => {
    const onChange = vi.fn();
    const el = await render(
      <ManagedAdvancedConfig
        serverId="server-1"
        providerId="claude"
        host={{ kind: 'host', sshHost: null, dir: '/work/pm' }}
        onChange={onChange}
      />
    );
    const disclosure = await vi.waitFor(() => {
      const found = [...el.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Advanced configuration')
      );
      expect(found?.textContent).toMatch(/3 fields/);
      return found!;
    });
    await act(async () => disclosure.click());
    const labels = [...el.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels).toEqual(['Model (optional)', 'Effort (optional)', 'Tools (optional)']);
    expect(modelCatalogue).toHaveBeenCalledWith({
      providerId: 'claude',
      sshHost: null,
      dir: '/work/pm',
    });
    expect(el.textContent).not.toMatch(/agent’s page/);

    await type(el.querySelector<HTMLInputElement>('#agent-definition-model')!, 'opus');
    await type(el.querySelector<HTMLInputElement>('#agent-definition-tools')!, 'Read, Grep');
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'opus',
      advancedConfig: { tools: ['Read', 'Grep'] },
    });
  });

  it('says why it cannot suggest models for a machine this Console cannot reach', async () => {
    const el = await render(
      <ManagedAdvancedConfig
        serverId="server-1"
        providerId="claude"
        host={{ kind: 'unavailable', reason: 'build-box is out of reach.' }}
        onChange={vi.fn()}
      />
    );
    const disclosure = await vi.waitFor(() => {
      const found = [...el.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Advanced configuration')
      );
      expect(found).toBeDefined();
      return found!;
    });
    await act(async () => disclosure.click());
    expect(el.textContent).toMatch(/build-box is out of reach\./);
    expect(modelCatalogue).not.toHaveBeenCalled();
  });

  it('says so when the server’s settings cannot be read', async () => {
    advancedConfigSchema.mockRejectedValue(new Error('The server is down for maintenance.'));
    const el = await render(
      <ManagedAdvancedConfig
        serverId="server-1"
        providerId="claude"
        host={{ kind: 'host', sshHost: null, dir: '/work/pm' }}
        onChange={vi.fn()}
      />
    );
    await vi.waitFor(() =>
      expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/could not be read/)
    );
  });
});

describe('can manage agents, set as the agent is created', () => {
  it('starts off and turns on when switched', async () => {
    const onChange = vi.fn();
    const el = await render(<CanManageAgentsField checked={false} onChange={onChange} />);
    const toggle = el.querySelector('[aria-label="Can manage agents"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    expect(el.textContent).toMatch(/Let this agent create agents on your machines\./);
    expect(el.querySelector('[aria-label="More info about managing agents"]')).not.toBeNull();
  });
});

function DirectoryHarness({ machine, name }: { machine: OwnedMachine; name: string }) {
  const suggested = useSuggestedManagedDirectory('server-1', machine, name);
  return (
    <ManagedDirectoryField
      machine={machine}
      machineLabel={machine.name}
      value={suggested.path ?? ''}
      suggested={suggested}
      onChange={() => {}}
    />
  );
}

describe('the directory a new managed agent runs in', () => {
  it('starts as the machine’s workspaces folder and the agent’s name', async () => {
    const el = await render(
      <DirectoryHarness machine={{ ...BOX, workspacesDir: '/srv/ws' }} name="pm-agent" />
    );
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Directory"]')?.value).toBe(
      '/srv/ws/pm-agent'
    );
    expect(el.textContent).toMatch(/Where the agent runs on build-box\./);
    expect(defaultWorkspace).not.toHaveBeenCalled();
  });

  it('asks this computer where it keeps workspaces when its machine has not said', async () => {
    const el = await render(
      <DirectoryHarness machine={{ ...BOX, local: { kind: 'this-computer' } }} name="pm-agent" />
    );
    await vi.waitFor(() =>
      expect(el.querySelector('[title="/home/me/.switch/workspaces/pm-agent"]')).not.toBeNull()
    );
    expect(defaultWorkspace).toHaveBeenCalledWith({ serverId: 'server-1', name: 'pm-agent' });
  });
});

const BOX: OwnedMachine = {
  acceptsLogins: false,
  cloud: false,
  id: 'controller-7',
  name: 'build-box',
  kind: 'daemon',
  state: 'online',
  local: null,
  workspacesDir: null,
  providers: [
    { provider: 'claude', ready: true, problem: null },
    { provider: 'codex', ready: false, problem: 'not logged in' },
    { provider: 'opencode', ready: false, problem: 'not installed' },
  ],
};

function tile(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith(name)
  );
  if (!found) throw new Error(`No tile for ${name}`);
  return found;
}

describe('the providers a server machine offers', () => {
  it('offers only the providers the machine reports ready, and says why the others are not', async () => {
    const onChange = vi.fn();
    const el = await render(
      <MachineProviderPicker
        serverId="server-1"
        machine={BOX}
        value="claude"
        onChange={onChange}
        defaultAgent="claude"
      />
    );
    expect(tile(el, 'Claude Code').disabled).toBe(false);
    expect(tile(el, 'Claude Code').textContent).toMatch(/Ready/);
    expect(tile(el, 'Codex').disabled).toBe(true);
    expect(tile(el, 'Codex').textContent).toMatch(/Not logged in/);
    expect(tile(el, 'OpenCode').textContent).toMatch(/Not installed/);
    expect(tile(el, 'Cursor').disabled).toBe(true);
    expect(tile(el, 'Cursor').textContent).toMatch(/Not checked yet/);
    await act(async () => tile(el, 'Codex').click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks the one ready provider for the user', async () => {
    const onChange = vi.fn();
    await render(
      <MachineProviderPicker
        serverId="server-1"
        machine={BOX}
        value={null}
        onChange={onChange}
        defaultAgent={undefined}
      />
    );
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('says when the machine has not reported its providers, and picks none', async () => {
    const onChange = vi.fn();
    const el = await render(
      <MachineProviderPicker
        serverId="server-1"
        machine={{ ...BOX, providers: [] }}
        value={null}
        onChange={onChange}
        defaultAgent="claude"
      />
    );
    expect(el.textContent).toMatch(/build-box has not reported its providers yet/);
    expect([...el.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gives the machine a login for a provider installed there but not signed in', async () => {
    giveMachineLogin.mockReset().mockResolvedValue({ operationId: 'op-1' });
    machineLoginOutcome.mockReset().mockResolvedValue({ state: 'succeeded' });
    const el = await render(
      <MachineProviderPicker
        serverId="server-1"
        machine={{ ...BOX, acceptsLogins: true }}
        value="claude"
        onChange={vi.fn()}
        defaultAgent="claude"
      />
    );
    expect(el.textContent).toMatch(/Give build-box a login for/);
    const offered = [...el.querySelectorAll('button')].filter((button) =>
      ['Codex', 'Cursor', 'OpenCode'].includes(button.textContent ?? '')
    );
    // Not OpenCode: it is not installed there, and no login would change that.
    expect(offered.map((button) => button.textContent)).toEqual(['Codex', 'Cursor']);
    await act(async () => offered[0]!.click());
    const input = el.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, 'sk-proj-placeholder');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const giveButton = [...el.querySelectorAll('button')].find(
      (button) => button.textContent === 'Give login'
    )!;
    await act(async () => giveButton.click());
    await vi.waitFor(() => expect(el.textContent).toMatch(/Codex signs in on build-box/));
    expect(giveMachineLogin).toHaveBeenCalledWith({
      serverId: 'server-1',
      machineId: 'controller-7',
      provider: 'codex',
      login: { source: 'typed', kind: 'api-key', credential: 'sk-proj-placeholder' },
    });
  });

  it('offers no login to a machine that cannot take one', async () => {
    const el = await render(
      <MachineProviderPicker
        serverId="server-1"
        machine={BOX}
        value="claude"
        onChange={vi.fn()}
        defaultAgent="claude"
      />
    );
    expect(el.textContent).not.toMatch(/Give build-box a login/);
  });
});
