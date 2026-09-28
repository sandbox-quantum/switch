import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Several Consoles under one account on a shared host each hold a row for the
 * same agent, and each writes the one watcher on the host (CHOO-2893). What
 * they share is the last choice a person made, kept beside the watcher: every
 * write takes auto-approve from it but the one that follows a change, and a
 * saved spec is never taken for a choice.
 *
 * The scripts run for real, with `node`, against a directory standing in for
 * the watcher's state root on the host.
 */

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  location: vi.fn(),
  deploy: vi.fn(),
  runCommand: vi.fn(),
  updateAgent: vi.fn(),
  stopLegacySidecar: vi.fn(),
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
vi.mock('./watcher-inspection', () => ({ waitForWatcherStop: 'process.exit(0)' }));
vi.mock('./adopt-subagent', () => ({ adoptSubagent: vi.fn() }));
vi.mock('./local-host', () => ({ startLocalWatcher: vi.fn(), stopLocalWatcher: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const { configureSharedWatcher, keepAutoApproveChoice, recordAutoApproveOnHost } =
  await import('./shared-watcher');

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

/** A person's choice, kept beside the watcher by a sharing-aware Console. */
function chosen(runtimeMode: string) {
  writeFileSync(join(root, 'auto-approve.json'), JSON.stringify({ runtimeMode, at: 'then' }));
}

function readChoice(): { runtimeMode: string } {
  return JSON.parse(readFileSync(join(root, 'auto-approve.json'), 'utf8'));
}

function readSpec(): { start: { input: { runtimeMode: string } } } {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
}

/** The runtime mode the watcher was last written with. */
function writtenMode(): string {
  const [, , config] = mocks.runCommand.mock.calls.at(-1) as [
    unknown,
    unknown,
    { start: { input: { runtimeMode: string } } },
  ];
  return config.start.input.runtimeMode;
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('takes auto-approve from the host when another Console changed it', async () => {
  // This Console's row says off; a Console under the same account turned it
  // on since. Restarting must not turn it back off.
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('full-access');
  chosen('full-access');

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(writtenMode()).toBe('full-access');
  // And this Console's toggle is brought in line with what the agent runs with.
  expect(mocks.updateAgent).toHaveBeenCalledWith({ agentId: 'agent-1', autoApprove: true });
});

it('leaves the row alone when it already agrees with the host', async () => {
  mocks.agent.mockResolvedValue(agent(true));
  savedSpec('full-access');
  chosen('full-access');

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(writtenMode()).toBe('full-access');
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('does not take a saved spec for a choice when nobody made one', async () => {
  // An older Console wrote the spec from its own row and never kept a choice:
  // a change this row holds that the spec missed must not be reverted.
  mocks.agent.mockResolvedValue(agent(true));
  savedSpec('approval-required');

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(writtenMode()).toBe('full-access');
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('writes the first watcher from the row, with no spec on the host yet', async () => {
  mocks.agent.mockResolvedValue(agent(true));

  await configureSharedWatcher('agent-1', { connected: true, spawning: true }, 'explicit');

  expect(writtenMode()).toBe('full-access');
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('writes this Console’s value when the person using it has just changed it', async () => {
  mocks.agent.mockResolvedValue(agent(true));
  savedSpec('approval-required');

  await configureSharedWatcher(
    'agent-1',
    { connected: true, spawning: true },
    'explicit',
    undefined,
    'this-console'
  );

  expect(writtenMode()).toBe('full-access');
  expect(mocks.updateAgent).not.toHaveBeenCalled();
});

it('does not take a subagent watcher’s setting for its parent’s', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('full-access');
  chosen('full-access');
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

  expect(writtenMode()).toBe('approval-required');
  expect(mocks.updateAgent).not.toHaveBeenCalled();
  readId.mockRestore();
});

it('keeps a changed setting on the host for a watcher that starts no sessions', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('approval-required');

  // The value is the one just chosen, which the row does not hold yet.
  await recordAutoApproveOnHost('agent-1', true);

  expect(readSpec().start.input.runtimeMode).toBe('full-access');
  expect(readChoice().runtimeMode).toBe('full-access');
  expect(mocks.runCommand).not.toHaveBeenCalled();
  // A small edit beside the watcher: nothing is deployed for it.
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it('keeps a choice on the host without touching a watcher about to be rewritten', async () => {
  mocks.agent.mockResolvedValue(agent(false));
  savedSpec('approval-required');

  await keepAutoApproveChoice('agent-1', true);

  expect(readChoice().runtimeMode).toBe('full-access');
  // The push that follows rewrites the spec from the row.
  expect(readSpec().start.input.runtimeMode).toBe('approval-required');
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it('has nothing to record for an agent that has never had a watcher', async () => {
  mocks.agent.mockResolvedValue(agent(true));
  rmSync(root, { recursive: true, force: true });

  await recordAutoApproveOnHost('agent-1', true);

  expect(() => readSpec()).toThrow(/ENOENT/);
});
