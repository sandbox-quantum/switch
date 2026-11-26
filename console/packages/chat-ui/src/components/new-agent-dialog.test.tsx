import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent } from '../primitives/dialog';
import {
  type NewAgentDevice,
  NewAgentDialog,
  type NewAgentHost,
  type NewAgentProvider,
} from './new-agent-dialog';

const OWNER_AND_AGENTS = {
  rules: [{ rooms: '*', room_groups: '*', users: [], agents: [], owner: true, owner_agents: true }],
} as const;

const cloud: NewAgentDevice = {
  id: 'box',
  name: 'Switch Cloud',
  cloud: true,
  online: true,
  tag: 'cloud',
  icon: 'cloud',
  os: 'linux',
  workspacesDir: '/home/agents/workspaces',
  acceptsLogins: true,
  providers: [
    { provider: 'claude', ready: true, problem: null },
    { provider: 'codex', ready: false, problem: 'not signed in' },
  ],
};

const providers: NewAgentProvider[] = [
  { id: 'claude', name: 'Claude', fields: [] },
  { id: 'codex', name: 'Codex', fields: [] },
];

function hostWith(overrides: Partial<NewAgentHost>): NewAgentHost {
  return {
    cloudOnly: false,
    devices: [cloud],
    devicesError: null,
    providers,
    providersError: null,
    takenNames: new Set(['taken']),
    machineWord: 'device',
    takenWhere: 'here',
    reportedTo: 'Switch',
    formRules: { namePattern: /^[a-z0-9][a-z0-9._-]*$/, slugify: (value) => value.toLowerCase() },
    permissionsFor: () => ({
      autoApprove: false,
      autoMode: true,
      supportsAutoMode: true,
      unreviewedAutoMode: null,
    }),
    initialPolicy: () => OWNER_AND_AGENTS as never,
    thirdPartyAvatarsEnabled: true,
    iconPicker: () => null,
    addressing: () => null,
    providerIcon: () => null,
    loginOffered: (provider) => provider === 'codex',
    giveLogin: (device, provider) => (
      <p>
        Give {device.name} a {provider} login
      </p>
    ),
    createAgent: vi.fn(async () => ({ agentId: 'a1' })),
    finishSetup: vi.fn(async () => {}),
    openAgent: vi.fn(),
    otherWays: [],
    addDevice: vi.fn(),
    setCloseGuard: vi.fn(),
    onClose: vi.fn(),
    ConfirmButton: (props) => <button {...props} />,
    ...overrides,
  };
}

/** The dialog as an app draws it: inside a dialog's content. */
function show(host: NewAgentHost) {
  render(
    <Dialog open>
      <DialogContent>
        <NewAgentDialog host={host} />
      </DialogContent>
    </Dialog>
  );
}

function fill(name: string, description: string) {
  fireEvent.change(screen.getByPlaceholderText('Name this agent'), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText('What is this agent for?'), {
    target: { value: description },
  });
}

describe('NewAgentDialog', () => {
  afterEach(cleanup);

  it('creates the agent on the device it picked, sets it up, and opens it', async () => {
    const host = hostWith({});
    show(host);

    // The only device is picked, and its only ready provider with it.
    expect(screen.getByText('Runs as a managed agent on Switch Cloud.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Claude/ }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    // Codex is installed but not signed in: its card carries a button giving the device a login.
    expect(screen.queryByText(/a login for/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Give Switch Cloud a login for Codex' }));
    expect(screen.getByText('Give Switch Cloud a codex login')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Give Switch Cloud a login for Claude' })
    ).toBeNull();

    const add = screen.getByRole('button', { name: 'Add agent' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fill('helper', 'Helps');
    expect(add.disabled).toBe(false);
    await act(async () => add.click());

    expect(host.createAgent).toHaveBeenCalledWith({
      name: 'helper',
      description: 'Helps',
      displayName: null,
      iconUrl: expect.stringContaining('dicebear'),
      deviceId: 'box',
      directory: '/home/agents/workspaces/helper',
      provider: 'claude',
      model: null,
      advancedConfig: {},
      instructions: '',
      autoMode: true,
      autoApprove: false,
      isolation: 'isolated',
    });
    expect(host.finishSetup).toHaveBeenCalledWith('a1', {
      addressingPolicy: OWNER_AND_AGENTS,
      canManageAgents: false,
    });
    expect(host.onClose).toHaveBeenCalled();
    expect(host.openAgent).toHaveBeenCalledWith('a1');
  });

  it('says in each card why a provider cannot be picked, with Give login where a login helps', () => {
    show(
      hostWith({
        devices: [
          {
            ...cloud,
            providers: [
              ...cloud.providers,
              { provider: 'opencode', ready: false, problem: 'not installed' },
            ],
          },
        ],
        providers: [
          ...providers,
          { id: 'opencode', name: 'OpenCode', fields: [] },
          { id: 'antigravity', name: 'Antigravity', fields: [] },
        ],
        loginOffered: () => true,
      })
    );
    const opencode = screen.getByRole('button', { name: /^OpenCode/ });
    expect(opencode.textContent).toContain('Not installed on Switch Cloud');
    expect(
      screen.queryByRole('button', { name: 'Give Switch Cloud a login for OpenCode' })
    ).toBeNull();
    // Not reported yet, so a login may be what it needs.
    expect(screen.getByRole('button', { name: /^Antigravity/ }).textContent).toContain(
      'Not checked yet'
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Give Switch Cloud a login for Antigravity' })
    );
    expect(screen.getByText('Give Switch Cloud a antigravity login')).toBeTruthy();
  });

  it('asks no Run location where the agent always runs on Switch Cloud', async () => {
    const host = hostWith({ cloudOnly: true });
    show(host);
    expect(screen.queryByText('Run location')).toBeNull();
    expect(screen.getByText('Runs on your Switch Cloud device.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Claude/ }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    fill('helper', 'Helps');
    await act(async () => screen.getByRole('button', { name: 'Add agent' }).click());
    expect(host.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'box', isolation: 'isolated' })
    );
  });

  it('waits for the Switch Cloud device to start, offering no other device', () => {
    show(hostWith({ cloudOnly: true, devices: [] }));
    expect(screen.queryByText('Run location')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a device/ })).toBeNull();
    expect(
      screen.getByText('Your Switch Cloud device is starting. This can take a few minutes.')
    ).toBeTruthy();
    fill('helper', 'Helps');
    expect((screen.getByRole('button', { name: 'Add agent' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('refuses a name already taken here, and an offline device, saying why', () => {
    show(hostWith({ devices: [{ ...cloud, online: false }] }));
    fill('taken', 'Helps');
    expect(screen.getByText(/already exists/).textContent).toBe(
      'An agent called taken already exists here. Pick another name.'
    );
    fill('fresh', 'Helps');
    expect(
      screen.getAllByText(
        'Switch Cloud is offline. Start its controller, or choose another device.'
      ).length
    ).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Add agent' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('keeps the dialog open and says what Switch refused, creating nothing', async () => {
    const host = hostWith({
      createAgent: vi.fn(async () => {
        throw new Error('Claude is not signed in on Switch Cloud.');
      }),
    });
    show(host);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Claude/ }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    fill('helper', 'Helps');
    await act(async () => screen.getByRole('button', { name: 'Add agent' }).click());

    expect(
      await screen.findByText(/Nothing was created.*Claude is not signed in on Switch Cloud\./)
    ).toBeTruthy();
    expect(host.finishSetup).not.toHaveBeenCalled();
    expect(host.onClose).not.toHaveBeenCalled();
    expect(host.setCloseGuard).toHaveBeenLastCalledWith(false);
  });

  it('says an agent was created when only its settings failed, and opens it from there', async () => {
    const host = hostWith({
      finishSetup: vi.fn(async () => {
        throw new Error('Forbidden.');
      }),
    });
    show(host);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Claude/ }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    );
    fill('helper', 'Helps');
    await act(async () => screen.getByRole('button', { name: 'Add agent' }).click());

    expect(
      await screen.findByText(/Agent created, but setup is incomplete: .*Forbidden\./)
    ).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add agent' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open the agent' }));
    expect(host.openAgent).toHaveBeenCalledWith('a1');
  });
});
