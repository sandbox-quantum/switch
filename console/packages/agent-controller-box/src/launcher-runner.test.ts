import type { SharedHostConfig } from '@switch-console/agent-providers-box';
import { describe, expect, it } from 'vitest';
import { HostTickets } from './host-tickets';
import type { LauncherOrder, LauncherReport } from './launcher-protocol';
import { credentialsCrossing, failureLine, LauncherRunner } from './launcher-runner';
import { OwnerMarkers } from './owner-marker';
import { isCredentialFailure } from './status';
import { buildWatcherTemplate } from './template';

const AGENT = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
type Reply = Extract<LauncherReport, { kind: 'reply' }>;

function setup(
  answer: (order: Omit<LauncherOrder, 'id'>) => Partial<Reply> = () => ({ ok: true })
) {
  const orders: Omit<LauncherOrder, 'id'>[] = [];
  const tickets = new HostTickets();
  const markers = new OwnerMarkers(Buffer.alloc(32, 5));
  const runner = new LauncherRunner({
    link: {
      order: async (order) => {
        orders.push(order);
        return { kind: 'reply', id: orders.length, ok: true, ...answer(order) } as Reply;
      },
    },
    tickets,
    markers,
    // Launch ids start from the clock, so none from before a restart comes back.
    now: () => 1,
    credentials: () => ({
      endpoint: 'http://127.0.0.1:1',
      token: 'swlr_x',
      hub: 'ws://h',
      providerLogin: { kind: 'x' } as never,
    }),
  });
  return { runner, orders, tickets, markers };
}
const options = {
  isolation: 'isolated' as const,
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
};
const template = () =>
  ({ start: { input: { cwd: '/data/workspaces/a', env: {} } } }) as unknown as SharedHostConfig;

describe('LauncherRunner', () => {
  it('launches with a fresh launch id, that launch’s own marker, a ticket the host can spend once, and no login', async () => {
    const { runner, orders, tickets, markers } = setup();
    await runner.launch(AGENT, template(), options);
    await runner.launch(AGENT, template(), { ...options, restart: true });
    const [first, second] = orders as Extract<LauncherOrder, { kind: 'launch' }>[];
    expect(first!.launchId).toBe(1);
    expect(second!.launchId).toBe(2);
    expect(first!.marker).toBe(markers.markerForLaunch(AGENT, 1));
    expect(second!.marker).not.toBe(first!.marker);
    expect(first!.credentials).toEqual({
      endpoint: 'http://127.0.0.1:1',
      token: 'swlr_x',
      hub: 'ws://h',
    });
    // The second launch's ticket replaced the first's.
    expect(tickets.take(AGENT, first!.ticket)).toEqual({ ok: false, reason: 'expired' });
    expect(tickets.take(AGENT, second!.ticket)).toEqual({ ok: true, launchId: 2 });
    expect(runner.launchOf(AGENT)).toBe(2);
    expect(first!.directory).toBe('/data/workspaces/a');
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CURSOR_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'SOME_VENDOR_API_KEY',
  ])('refuses a start whose %s carries anything but empty or a gateway token', async (name) => {
    const { runner, orders } = setup();
    const carrying = template();
    carrying.start.input.env = { [name]: 'real-secret-value' };
    await expect(runner.launch(AGENT, carrying, options)).rejects.toThrow(name);
    expect(orders).toEqual([]);
    // Empty (how a login is cleared) or the gateway's own per-agent token: fine.
    const cleared = template();
    cleared.start.input.env = { [name]: '' };
    await runner.launch(AGENT, cleared, options);
    const gateway = template();
    gateway.start.input.env = { [name]: 'swpg_0123456789abcdef0123' };
    await runner.launch(AGENT, gateway, options);
    expect(orders.map((o) => o.kind)).toEqual(['launch', 'launch']);
  });

  it('leaves variables that carry no credential alone', () => {
    expect(
      credentialsCrossing({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/swpg_x',
        CLAUDE_CODE_USE_VERTEX: '1',
        PATH: '/usr/bin',
      })
    ).toEqual([]);
  });

  it('never sends the controller credential, the marker key or another agent’s token (C3)', async () => {
    const markerKey = Buffer.alloc(32, 5).toString('hex');
    const controllerCredential = 'swc_controller_secret_value_0123456789';
    process.env.SWITCH_TEST_CONTROLLER_CREDENTIAL = controllerCredential;
    try {
      const { runner, orders } = setup();
      const real = buildWatcherTemplate({
        agentId: AGENT,
        provider: 'claude',
        definition: {
          name: 'a',
          model: null,
          advanced_config: {},
          instructions: '',
          auto_approve: true,
          auto_mode: false,
        },
        cwd: '/data/workspaces/a',
        credentialsPath: '/data/agents/a/credentials.json',
        binaryPath: '/usr/bin/claude',
      });
      await runner.launch(AGENT, real, options);
      const line = JSON.stringify(orders[0]);
      expect(line).not.toContain(markerKey);
      expect(line).not.toContain(controllerCredential);
      // The credentials are exactly this agent's relay ones, nothing more.
      expect(
        Object.keys((orders[0] as Extract<LauncherOrder, { kind: 'launch' }>).credentials).sort()
      ).toEqual(['endpoint', 'hub', 'token']);
    } finally {
      delete process.env.SWITCH_TEST_CONTROLLER_CREDENTIAL;
    }
  });

  it('names the launch being ordered as current, so its host can say hello before the reply', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { runner } = setup();
    const slow = new LauncherRunner({
      link: { order: async () => (await held, { kind: 'reply', id: 1, ok: true }) as Reply },
      tickets: new HostTickets(),
      markers: new OwnerMarkers(Buffer.alloc(32, 5)),
      credentials: () => ({ endpoint: 'e', token: 't', hub: 'h', providerLogin: null }),
      now: () => 40,
    });
    const launching = slow.launch(AGENT, template(), options);
    await new Promise((resolve) => setImmediate(resolve));
    expect(slow.currentLaunch(AGENT)).toBe(40);
    expect(slow.launchOf(AGENT)).toBeNull();
    release();
    await launching;
    expect(slow.currentLaunch(AGENT)).toBe(40);
    expect(runner.currentLaunch(AGENT)).toBeNull();
  });

  it('a refused launch throws, and its ticket is gone', async () => {
    const { runner, orders, tickets } = setup(() => ({ ok: false, code: 'bad_template' }));
    await expect(runner.launch(AGENT, template(), options)).rejects.toThrow(/bad_template/);
    const launch = orders[0] as Extract<LauncherOrder, { kind: 'launch' }>;
    expect(tickets.take(AGENT, launch.ticket)).toEqual({ ok: false, reason: 'expired' });
  });

  it('stopping ends any unspent ticket', async () => {
    const { runner, orders, tickets } = setup();
    await runner.launch(AGENT, template(), options);
    await runner.stop(AGENT, { wait: true });
    expect(orders[1]).toEqual({ kind: 'stop', agentId: AGENT, wait: true, asked: true });
    const launch = orders[0] as Extract<LauncherOrder, { kind: 'launch' }>;
    expect(tickets.take(AGENT, launch.ticket)).toEqual({ ok: false, reason: 'expired' });
  });

  it('takes an observation only in its strict shape, and counts anything else as not seen', async () => {
    const health = {
      state: 'connected',
      detail: null,
      since: '2026-10-28T00:00:00Z',
      pid: 7,
      updatedAt: '2026-10-28T00:00:00Z',
      current: true,
    };
    const good = setup(() => ({
      ok: true,
      observation: {
        alive: true,
        health: { nonsense: 1 },
        failure: 'host_failed',
        outdated: false,
      },
    }));
    const seen = await good.runner.observe(AGENT);
    expect(seen.alive).toBe(true);
    expect(seen.health).toBeNull();
    expect(seen.failure).toBe(failureLine('host_failed'));
    // A failure that isn't a known code is never shown as written (C6): it's `other`.
    const words = setup(() => ({
      ok: true,
      observation: { alive: false, health: null, failure: 'rm -rf / please', outdated: false },
    }));
    expect((await words.runner.observe(AGENT)).failure).toBe('The agent host reported a failure.');
    // An extra field, or a failure past 64 characters: not taken at all.
    for (const observation of [
      { alive: true, health: null, failure: null, outdated: false, configured: { cwd: '/etc' } },
      { alive: true, health: null, failure: 'x'.repeat(65), outdated: false },
    ]) {
      const bad = setup(() => ({ ok: true, observation }));
      expect(await bad.runner.observe(AGENT)).toMatchObject({
        alive: false,
        failure: failureLine('bad_observation'),
      });
    }
    // Health is held to its own strict shape too.
    const extraHealth = setup(() => ({
      ok: true,
      observation: { alive: true, health: { ...health, extra: 1 }, failure: null, outdated: false },
    }));
    expect((await extraHealth.runner.observe(AGENT)).health).toBeNull();
    const lost = setup(() => ({ ok: false, code: 'launcher_lost' }));
    const notAnswered = await lost.runner.observe(AGENT);
    expect(notAnswered.alive).toBe(false);
    // The status says why, in the controller's own words.
    expect(notAnswered.failure).toBe('The launcher in the agents container is not connected.');
    // A rejected credential keeps the words the status looks for.
    expect(isCredentialFailure(failureLine('credentials_rejected'))).toBe(true);
  });
});
