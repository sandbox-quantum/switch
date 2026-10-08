import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sealProviderLogin } from '@switch-console/agent-providers';
import { afterAll, describe, expect, it } from 'vitest';
import { type ControllerExit, runController } from './controller';
import { silentLogger } from './log';
import type { AgentAssignment, StatusReport } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import {
  agentRoot,
  loadSeparateUsersConfig,
  type SeparateUsersConfig,
  separateUserNames,
} from './separate-users';
import { ControllerStore } from './store';
import { SystemdRuntime, systemctl } from './systemd-runtime';
import { FakeCore } from './testing/fake-core';

/**
 * Runs real agents as users of their own, under systemd, against a fake Core.
 * It needs a machine set up with `install-service --separate-users` for a
 * data directory holding a `controller.db`, with the controller service
 * stopped, and runs as that controller's user with the agents' group:
 *
 *   sudo setpriv --reuid=$USER --regid=$(id -g) --groups=$(id -g),<agents gid> --reset-env \
 *     env SWITCH_SEPARATE_USERS_E2E=<data dir> SWITCH_SEPARATE_USERS_E2E_CLAUDE=<fake claude> \
 *     PATH=$PATH HOME=$HOME pnpm exec vitest run systemd-runtime.e2e
 *
 * The fake `claude`, outside any home directory, answers `auth status` with
 * `{"loggedIn": true}` only when `CLAUDE_CODE_OAUTH_TOKEN` is set: the machine
 * has no Claude login of its own, and one given to it signs in.
 */
const dataDir = process.env.SWITCH_SEPARATE_USERS_E2E;
const fakeClaude = process.env.SWITCH_SEPARATE_USERS_E2E_CLAUDE ?? '/usr/bin/claude';

function agent(agentId: string, name: string): AgentAssignment {
  return {
    agent_id: agentId,
    revision: 1,
    desired_state: 'running',
    definition: {
      name,
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      directory: null,
      isolation: 'shared',
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(100);
  }
}

/** The agent's process in the latest status report from `since` on that names it. */
function latestProcess(core: FakeCore, agentId: string, since = 0): string | undefined {
  const reports: StatusReport[] = core.statusReports;
  for (let index = reports.length - 1; index >= since; index--) {
    const entry = reports[index]!.agents.find((status) => status.agent_id === agentId);
    if (entry) return entry.process;
  }
  return undefined;
}

async function unitUser(unit: string): Promise<string> {
  const pid = (await systemctl(['show', unit, '--property=MainPID', '--value'])).trim();
  return execFileSync('ps', ['-o', 'user:32=', '-p', pid], { encoding: 'utf8' }).trim();
}

describe.skipIf(!dataDir)('agents as users of their own, under systemd', () => {
  let config: SeparateUsersConfig;
  let store: ControllerStore;
  let core: FakeCore;
  let stop: AbortController;
  let running: Promise<ControllerExit>;

  afterAll(async () => {
    stop?.abort();
    await running?.catch(() => {});
    await core?.stop();
    for (const slot of [1, 2, 3])
      await systemctl(['stop', separateUserNames(config.uid).agentUnit(slot)]).catch(() => {});
    store?.close();
  });

  it('runs each agent as its own user, and frees the user when the agent goes', async () => {
    config = await loadSeparateUsersConfig(process.getuid!(), dataDir!);
    const names = separateUserNames(config.uid);
    store = ControllerStore.open(join(dataDir!, 'controller.db'));
    core = new FakeCore();
    await core.start();
    store.saveIdentity({
      controllerId: core.controllerId,
      server: core.url,
      name: 'e2e-box',
      enrolledAt: '2026-01-01T00:00:00Z',
    });
    core.setAssignment({
      revision: 1,
      agents: [agent('e2e-agent-1', 'first'), agent('e2e-agent-2', 'second')],
    });
    // A store that outlives the process, as a machine's own does: it keeps the sealing key.
    const secrets = new FileSecretStore(join(dataDir!, 'secrets'));
    await secrets.set(CONTROLLER_CREDENTIAL, core.credential);
    stop = new AbortController();
    running = runController(
      {
        store,
        secrets,
        runtime: () =>
          new SystemdRuntime({
            config,
            store,
            systemctl,
            env: { ...process.env, ANTHROPIC_API_KEY: "sk-e2e-not-real-'quoted'" },
            log: silentLogger,
            now: Date.now,
          }),
        locator: {
          locate: async (provider) =>
            provider === 'claude' ? { path: fakeClaude, version: '2.0.0' } : null,
        },
        fetch,
        openWebSocket: core.openWebSocket,
        log: silentLogger,
        dataDir: dataDir!,
        workspacesFor: () => join(dataDir!, 'workspaces'),
        version: '0.1.0',
        now: Date.now,
        random: () => 0,
        timing: {
          resyncMs: 60_000,
          statusPollMs: 200,
          statusMinGapMs: 100,
          defaultReportWithinS: 60,
          streamIdleMs: 5_000,
          streamInitialBackoffMs: 50,
          streamMaxBackoffMs: 500,
          eventBufferLimit: 100,
        },
      },
      stop.signal
    );

    await waitFor(
      () =>
        latestProcess(core, 'e2e-agent-1') === 'running' &&
        latestProcess(core, 'e2e-agent-2') === 'running',
      'both agents running'
    );
    const first = store.agentUser('e2e-agent-1');
    const second = store.agentUser('e2e-agent-2');
    expect(new Set([first, second])).toEqual(new Set([1, 2]));
    expect(await unitUser(names.agentUnit(first!))).toBe(names.agentUser(first!));
    expect(await unitUser(names.agentUnit(second!))).toBe(names.agentUser(second!));
    const root = agentRoot(config, first!);
    expect(readFileSync(join(root, '.switch-agent-id'), 'utf8').trim()).toBe('e2e-agent-1');
    const environment = readFileSync(join(dataDir!, 'units', `0${first}`, 'environment'), 'utf8');
    expect(environment).toContain('ANTHROPIC_API_KEY="sk-e2e-not-real-\'quoted\'"');

    // The machine has no Claude login of its own; its owner gives it one.
    await waitFor(() => core.publicKey !== null, 'the machine registering its key');
    core.sealedLogins.set('claude', {
      revision: 1,
      sealed: sealProviderLogin({
        publicKey: core.publicKey!,
        controllerId: core.controllerId,
        provider: 'claude',
        login: { kind: 'setup-token', credential: 'sk-ant-oat-e2e-given' },
      }),
    });
    core.addOperation({
      id: 'op-give',
      kind: 'provider.login',
      agent_id: null,
      params: { provider: 'claude', method: 'sealed', revision: 1 },
      created_at: '2026-01-01T00:00:00Z',
    });
    core.push('operation.pending', {
      operation_id: 'op-give',
      kind: 'provider.login',
      agent_id: null,
    });
    await waitFor(() => core.results.has('op-give'), 'the given login taken up');
    expect(core.results.get('op-give')).toMatchObject({ outcome: 'succeeded' });
    const configPath = join(root, 'watcher', 'config.json');
    await waitFor(
      () =>
        JSON.parse(readFileSync(configPath, 'utf8')).start.input.env.CLAUDE_CODE_OAUTH_TOKEN ===
        'sk-ant-oat-e2e-given',
      'the agent configured with the given login'
    );
    const relay = JSON.parse(
      readFileSync(join(dataDir!, 'units', `0${first}`, 'relay.json'), 'utf8')
    );
    expect(relay.providerLogin).toMatchObject({ provider: 'claude', revision: '1' });
    await waitFor(
      () => latestProcess(core, 'e2e-agent-1', core.statusReports.length - 1) === 'running',
      'the agent running again on the given login'
    );

    core.setAssignment({ revision: 2, agents: [agent('e2e-agent-1', 'first')] });
    core.push('assignment.changed', { revision: 2 });
    await waitFor(() => store.agentUser('e2e-agent-2') === null, 'the second agent’s user freed');
    const state = await systemctl(['is-active', names.agentUnit(second!)]).catch(
      (error: { stdout?: string }) => error.stdout ?? ''
    );
    expect(state.trim()).toBe('inactive');
    expect(existsSync(join(config.agentsDir, 'released', 'e2e-agent-2', 'watcher'))).toBe(true);

    // A new agent takes the freed user; the removed one comes back as another, with its directory.
    core.setAssignment({
      revision: 3,
      agents: [agent('e2e-agent-1', 'first'), agent('e2e-agent-3', 'third')],
    });
    core.push('assignment.changed', { revision: 3 });
    core.push('agent.attached', { agent_id: 'e2e-agent-3', from_seq: 0, rooms: [] });
    await waitFor(
      () => latestProcess(core, 'e2e-agent-3') === 'running',
      'the third agent running'
    );
    expect(store.agentUser('e2e-agent-3')).toBe(second);
    core.setAssignment({
      revision: 4,
      agents: [
        agent('e2e-agent-1', 'first'),
        agent('e2e-agent-3', 'third'),
        agent('e2e-agent-2', 'second'),
      ],
    });
    const reported = core.statusReports.length;
    core.push('assignment.changed', { revision: 4 });
    core.push('agent.attached', { agent_id: 'e2e-agent-2', from_seq: 0, rooms: [] });
    await waitFor(
      () => latestProcess(core, 'e2e-agent-2', reported) === 'running',
      'the second agent back'
    );
    const moved = store.agentUser('e2e-agent-2')!;
    expect(moved).not.toBe(second);
    expect(await unitUser(names.agentUnit(moved))).toBe(names.agentUser(moved));
    const back = JSON.parse(
      readFileSync(join(agentRoot(config, moved), 'watcher', 'config.json'), 'utf8')
    );
    expect(back.start.input.cwd).toBe(join(config.agentsDir, 'agent', 'workspace'));
    const owners = execFileSync(
      'find',
      [
        join(agentRoot(config, moved), 'watcher'),
        '-mindepth',
        '1',
        '-maxdepth',
        '1',
        '-printf',
        '%u\n',
      ],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);
    expect(new Set(owners)).toEqual(new Set([config.user, names.agentUser(moved)]));

    stop.abort();
    expect(await running).toBe('stopped');
    // Agents outlive the controller.
    expect((await systemctl(['is-active', names.agentUnit(first!)])).trim()).toBe('active');
  }, 120_000);
});
