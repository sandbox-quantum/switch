import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Auto-approve on a watcher that several Consoles under one account write
 * (CHOO-2893). The scripts run for real, with `node`, against a directory
 * standing in for the watcher's state root on the host.
 */

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  location: vi.fn(),
  deploy: vi.fn(),
  runCommand: vi.fn(),
  updateAgent: vi.fn(),
  stopLegacySidecar: vi.fn(),
  bringUp: vi.fn(),
}));

vi.mock('@main/core/agents/getAgentById', () => ({ getAgentById: mocks.agent }));
vi.mock('@main/core/managed-switch-server/session-readiness', () => ({
  ensureServerSessionReady: vi.fn(async () => {}),
}));
vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer: vi.fn(async () => null) }));
vi.mock('@main/core/switch-rooms/auto-session-store', () => ({
  listAutoSessionAgentIds: vi.fn(async () => []),
  listStoppedControllerAgentIds: vi.fn(async () => []),
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: vi.fn(),
}));
vi.mock('@main/core/agents/updateAgent', () => ({ updateAgent: mocks.updateAgent }));
vi.mock('@main/core/agents/agent-location', () => ({ getAgentLocation: mocks.location }));
vi.mock('@main/core/locations/location-manager', () => ({
  locationManager: {
    openLocation: async () => ({ success: true, data: { fs: {}, settings: {} } }),
  },
}));
vi.mock('@main/core/locations/location-runtime-factory', () => ({
  resolveSessionEnv: async () => ({ sessionEnvVars: {} }),
}));
vi.mock('./shared-agent-runtime', () => ({
  buildSharedHostConfig: async () => ({
    session: { sessionId: 'watcher', agentId: 'switch-agent-1' },
    start: {
      provider: 'claude',
      input: {
        sessionId: 'watcher',
        cwd: '/work',
        runtimeMode: (await mocks.agent()).autoApprove ? 'full-access' : 'approval-required',
      },
    },
    execution: { credentialsPath: '/work/.switch/agents/scout.json' },
  }),
}));
vi.mock('./shared-host-deployment', () => ({
  deploySharedHost: mocks.deploy,
  resolveWatcherRoot: async () => ({ ctx, root }),
  runSharedHostCommand: mocks.runCommand,
}));
vi.mock('./legacy-sidecar', () => ({ stopLegacySidecar: mocks.stopLegacySidecar }));
vi.mock('./watcher-inspection', () => ({}));
vi.mock('./watcher-bring-up', () => ({
  AUTO_APPROVE_CHOICE_FILE: 'auto-approve.json',
  bringUpRemoteWatcher: mocks.bringUp,
}));
vi.mock('./adopt-subagent', () => ({ adoptSubagent: vi.fn() }));
vi.mock('./local-host', () => ({ startLocalWatcher: vi.fn(), stopLocalWatcher: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const {
  configureSharedWatcher,
  configureSharedWatcherFor,
  keepAutoApproveChoice,
  recordAutoApproveOnHost,
} = await import('./shared-watcher');

const run = promisify(execFile);
let root: string;

/** A host whose commands are run here, for real. */
const ctx = {
  exec: async (command: string, args: string[]) => {
    const { stdout, stderr } = await run(command, args);
    return { stdout, stderr };
  },
};

function agent(autoApprove: boolean) {
  return { id: 'agent-1', name: 'scout', switchAgentId: 'switch-agent-1', autoApprove };
}

function savedSpec(runtimeMode: string) {
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ session: { agentId: 'switch-agent-1' }, start: { input: { runtimeMode } } })
  );
}

function readChoice(): { runtimeMode: string } {
  return JSON.parse(readFileSync(join(root, 'auto-approve.json'), 'utf8'));
}

function readSpec(): { start: { input: { runtimeMode: string } } } {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
}

/** Whether the bring-up was asked to take the host's choice into the watcher. */
function adopted(): boolean {
  return (mocks.bringUp.mock.calls.at(-1)![0] as { adoptAutoApprove: boolean }).adoptAutoApprove;
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'watcher-root-'));
  mocks.location.mockResolvedValue({
    id: 'remote',
    dir: '/work',
    sshHost: 'builder',
    connectionId: 'connection-1',
  });
  mocks.deploy.mockImplementation(async () => ({ ctx, root, entrypoint: 'shared-host.mjs' }));
  mocks.bringUp.mockResolvedValue({ root, runtimeMode: null, legacyStopped: [] });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// What the host's choice does to the watcher's spec is the bring-up script's,
// tested against real files in watcher-bring-up.test.ts. Here: when this
// Console asks for it, and what it does with the answer.

it('takes auto-approve from the host when another Console changed it', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  mocks.bringUp.mockResolvedValue({ root, runtimeMode: 'full-access', legacyStopped: [] });

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(adopted()).toBe(true);
  expect(mocks.updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', autoApprove: true });
});

it('leaves the row alone when it already agrees with the host', async () => {
  mocks.agent.mockResolvedValue(agent(true));

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(adopted()).toBe(true);
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('writes this Console’s value when the person using it has just changed it', async () => {
  mocks.agent.mockResolvedValue(agent(true));

  await configureSharedWatcherFor('agent-1', { connected: true, spawning: true }, 'explicit', {
    name: undefined,
    autoApprove: 'this-console',
  });

  expect(adopted()).toBe(false);
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('does not take a subagent watcher’s setting for its parent’s', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  // A subagent watcher reads its Switch id from the credentials file.
  const readId = vi.spyOn(ctx, 'exec');
  readId.mockImplementation(async (command: string, args: string[]) => {
    if (args[1]?.includes('SWITCH_AGENT_ID')) return { stdout: 'sub-id\n', stderr: '' };
    const { stdout, stderr } = await run(command, args);
    return { stdout, stderr };
  });

  await configureSharedWatcher(
    'agent-1',
    { connected: true, spawning: true },
    'explicit',
    'helper'
  );

  expect(adopted()).toBe(false);
  expect(mocks.updateAgent).not.toHaveBeenCalled();
  readId.mockRestore();
});

it('asks nothing of the host’s choice for a watcher being stopped', async () => {
  mocks.agent.mockResolvedValue(agent(true));

  await configureSharedWatcher('agent-1', { connected: false, spawning: false }, 'explicit');

  expect(adopted()).toBe(false);
});

it('keeps a changed setting on the host for a watcher that starts no sessions', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('approval-required');

  // The value is the one just chosen, which the row does not hold yet.
  await recordAutoApproveOnHost('agent-1', true);

  expect(readSpec().start.input.runtimeMode).toBe('full-access');
  expect(readChoice().runtimeMode).toBe('full-access');
  expect(mocks.runCommand).not.toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it('keeps auto-approve turned off on the host as asking for approval', async () => {
  mocks.agent.mockResolvedValue(agent(true));
  savedSpec('full-access');

  await recordAutoApproveOnHost('agent-1', false);

  expect(readSpec().start.input.runtimeMode).toBe('approval-required');
  expect(readChoice().runtimeMode).toBe('approval-required');
});

it('keeps a choice on the host without touching a watcher about to be rewritten', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('approval-required');

  await keepAutoApproveChoice('agent-1', true);

  expect(readChoice().runtimeMode).toBe('full-access');
  expect(readSpec().start.input.runtimeMode).toBe('approval-required');
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it('keeps nothing on a host for an agent that is not there, or never linked, or local', async () => {
  mocks.agent.mockResolvedValueOnce(undefined);
  await expect(keepAutoApproveChoice('agent-1', true)).rejects.toThrow(/does not exist/);

  mocks.agent.mockResolvedValueOnce({ ...agent(true), switchAgentId: null });
  await keepAutoApproveChoice('agent-1', true);

  mocks.agent.mockResolvedValueOnce(agent(true));
  mocks.location.mockResolvedValueOnce({ id: 'local', dir: '/work', sshHost: null });
  await recordAutoApproveOnHost('agent-1', true);

  expect(() => readChoice()).toThrow(/ENOENT/);
});

it('has nothing to record for an agent that has never had a watcher', async () => {
  mocks.agent.mockResolvedValue(agent(true));
  rmSync(root, { recursive: true, force: true });

  await recordAutoApproveOnHost('agent-1', true);

  expect(() => readSpec()).toThrow(/ENOENT/);
});
