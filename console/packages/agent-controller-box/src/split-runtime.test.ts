import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedHostConfig } from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostTickets } from './host-tickets';
import type { LauncherOrder, LauncherReport } from './launcher-protocol';
import { LauncherRunner } from './launcher-runner';
import { OwnerMarkers } from './owner-marker';
import { dataLayout } from './paths';
import { BURNT_LIMIT, LaunchGate, SplitRuntime } from './split-runtime';

const AGENT = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
type Reply = Extract<LauncherReport, { kind: 'reply' }>;

let dir: string;
let orders: Omit<LauncherOrder, 'id'>[];
let answer: (order: Omit<LauncherOrder, 'id'>) => Partial<Reply>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'split-runtime-'));
  orders = [];
  answer = () => ({ ok: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runtime(): SplitRuntime {
  const link = {
    order: async (order: Omit<LauncherOrder, 'id'>) => {
      orders.push(order);
      return { kind: 'reply', id: orders.length, ok: true, ...answer(order) } as Reply;
    },
  };
  let made: SplitRuntime | null = null;
  const runner = new LauncherRunner({
    link,
    tickets: new HostTickets(),
    markers: new OwnerMarkers(Buffer.alloc(32, 1)),
    credentials: (agentId) => made?.credentialsFor(agentId) ?? null,
    now: () => 1,
  });
  made = new SplitRuntime({
    runner,
    link,
    store: dataLayout(join(dir, 'controller')),
    agents: dataLayout('/data/agents'),
    workspaces: '/data/agents/workspaces',
  });
  return made;
}

const credentials = {
  endpoint: 'http://127.0.0.1:1',
  token: 'swlr_x',
  hub: 'ws://127.0.0.1:1/hub',
  providerLogin: null,
};
const template = () =>
  ({
    start: { input: { cwd: '/data/agents/workspaces/a', env: {} } },
  }) as unknown as SharedHostConfig;
const options = {
  isolation: 'shared' as const,
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
};

describe('SplitRuntime', () => {
  it('keeps credentials on the controller’s disk, and names the agents container’s path in templates', async () => {
    const r = runtime();
    await r.writeCredentials(AGENT, credentials);
    expect(existsSync(dataLayout(join(dir, 'controller')).agentCredentials(AGENT))).toBe(true);
    expect(r.credentialsPath(AGENT)).toBe(dataLayout('/data/agents').agentCredentials(AGENT));
    expect(r.agentStateRoot(AGENT)).toBe(dataLayout('/data/agents').watcherRoot(AGENT));
    // A fresh runtime reads them back before a launch needs them.
    const again = runtime();
    expect(again.credentialsFor(AGENT)).toBeNull();
    expect((await again.readCredentials(AGENT))?.token).toBe('swlr_x');
    expect(again.credentialsFor(AGENT)?.token).toBe('swlr_x');
    await again.deleteCredentials(AGENT);
    expect(again.credentialsFor(AGENT)).toBeNull();
    expect(await again.readCredentials(AGENT)).toBeNull();
  });

  it('launches every host through the launcher, even one asked to run in this process', async () => {
    const r = runtime();
    await expect(r.launch(AGENT, template(), options)).rejects.toThrow('no relay credentials');
    await r.writeCredentials(AGENT, credentials);
    await r.launch(AGENT, template(), options);
    expect(orders.map((o) => o.kind)).toEqual(['launch']);
  });

  it('works out the working directory without making it here', async () => {
    const r = runtime();
    expect(await r.workingDirectory(AGENT, 'a', null)).toBe('/data/agents/workspaces/a');
    expect(await r.workingDirectory(AGENT, 'a', '/srv/x/../y')).toBe('/srv/y');
    await expect(r.workingDirectory(AGENT, 'a', 'relative')).rejects.toThrow(
      'not an absolute path'
    );
    expect(existsSync('/data/agents/workspaces/a')).toBe(false);
  });

  it('warms and tells rooms through the launcher, and says why when it could not', async () => {
    const r = runtime();
    answer = (order) => (order.kind === 'memory_notice' ? { ok: true, told: 2 } : { ok: true });
    await r.warm(AGENT, '!room:x');
    expect(await r.stopForMemory(AGENT)).toBe(2);
    expect(orders).toEqual([
      { kind: 'warm', agentId: AGENT, roomId: '!room:x' },
      { kind: 'memory_notice', agentId: AGENT },
    ]);
    answer = () => ({ ok: false, code: 'launcher_lost' });
    await expect(r.warm(AGENT, '!room:x')).rejects.toThrow('launcher_lost');
    await expect(r.stopForMemory(AGENT)).rejects.toThrow('launcher_lost');
  });

  it('never runs a provider’s CLI as the controller’s user: the check is an order to the launcher', async () => {
    const r = runtime();
    answer = () => ({ ok: false, code: 'launcher_lost' });
    expect((await r.probe('claude', '/bin/false', dir, null)).status).toBe('unknown');
    expect(orders).toEqual([
      { kind: 'probe', provider: 'claude', binaryPath: '/bin/false', env: {} },
    ]);
  });
});

describe('LaunchGate', () => {
  it('fails an agent only after 3 burnt tickets in 10 minutes, until its owner changes it', () => {
    let clock = 0;
    const gate = new LaunchGate(() => clock);
    expect(typeof gate.burn(AGENT)).toBe('number');
    clock += 11 * 60_000; // the first falls out of the window
    expect(typeof gate.burn(AGENT)).toBe('number');
    expect(typeof gate.burn(AGENT)).toBe('number');
    expect(gate.isFailed(AGENT)).toBe(false);
    expect(gate.burn(AGENT)).toBe('failed');
    expect(() => gate.check(AGENT)).toThrow(`refused ${BURNT_LIMIT} times`);
    gate.clear(AGENT);
    expect(() => gate.check(AGENT)).not.toThrow();
  });

  it('never fails an agent for unknown or missing tickets: those only back off, doubling, until a good hello', () => {
    let clock = 0;
    const gate = new LaunchGate(() => clock);
    const waits = Array.from({ length: 10 }, () => gate.delay(AGENT));
    expect(waits.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(Math.max(...waits)).toBe(5 * 60_000);
    expect(gate.isFailed(AGENT)).toBe(false);
    expect(() => gate.check(AGENT)).toThrow('started again in');
    clock += 5 * 60_000;
    expect(() => gate.check(AGENT)).not.toThrow();
    gate.taken(AGENT);
    expect(gate.delay(AGENT)).toBe(5_000);
  });

  it('holds a launch back while the agent is failed or backing off', async () => {
    const gate = new LaunchGate(() => 0);
    const link = { order: async () => ({ kind: 'reply', id: 1, ok: true }) as Reply };
    let made: SplitRuntime | null = null;
    const r = new SplitRuntime({
      runner: new LauncherRunner({
        link,
        tickets: new HostTickets(),
        markers: new OwnerMarkers(Buffer.alloc(32, 1)),
        credentials: (agentId) => made?.credentialsFor(agentId) ?? null,
      }),
      link,
      store: dataLayout(join(dir, 'controller')),
      agents: dataLayout('/data/agents'),
      workspaces: '/data/agents/workspaces',
      gate,
    });
    made = r;
    await r.writeCredentials(AGENT, credentials);
    gate.delay(AGENT);
    await expect(r.launch(AGENT, template(), options)).rejects.toThrow('started again in');
  });
});

describe('SplitRuntime.probe', () => {
  it('runs the check in the agents container: with no login as is, with one only through the gateway probe', async () => {
    let ended = 0;
    answer = (order) =>
      order.kind === 'probe'
        ? { ok: true, readiness: { status: 'authenticated', message: 'ok', models: [] } }
        : { ok: true };
    const link = {
      order: async (order: Omit<LauncherOrder, 'id'>) => {
        orders.push(order);
        return { kind: 'reply', id: orders.length, ok: true, ...answer(order) } as Reply;
      },
    };
    const make = (probeEnv?: ConstructorParameters<typeof SplitRuntime>[0]['probeEnv']) =>
      new SplitRuntime({
        runner: new LauncherRunner({
          link,
          tickets: new HostTickets(),
          markers: new OwnerMarkers(Buffer.alloc(32, 1)),
          credentials: () => null,
        }),
        link,
        store: dataLayout(join(dir, 'controller')),
        agents: dataLayout('/data/agents'),
        workspaces: '/data/agents/workspaces',
        probeEnv,
      });
    const login = { provider: 'claude', kind: 'api-key', credential: 'sk-ant-real' } as never;
    // No gateway hook: a given login is never sent anywhere, and says so.
    expect((await make().probe('claude', '/usr/bin/claude', dir, login)).status).toBe('unknown');
    expect(orders).toEqual([]);
    const r = make(async () => ({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ANTHROPIC_AUTH_TOKEN: 'swpg_probe_0123456789abcdef',
      },
      done: () => void ended++,
    }));
    expect((await r.probe('claude', '/usr/bin/claude', dir, login)).status).toBe('authenticated');
    expect(orders).toEqual([
      {
        kind: 'probe',
        provider: 'claude',
        binaryPath: '/usr/bin/claude',
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'swpg_probe_0123456789abcdef',
        },
      },
    ]);
    expect(JSON.stringify(orders)).not.toContain('sk-ant-real');
    expect(ended).toBe(1);
    // A probe environment carrying a real credential is never sent, and the probe still ends.
    const leaky = make(async () => ({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-real' },
      done: () => void ended++,
    }));
    const sentBefore = orders.length;
    const refused = await leaky.probe('claude', '/usr/bin/claude', dir, login);
    expect(refused.status).toBe('unknown');
    expect(refused.message).toContain('ANTHROPIC_API_KEY');
    expect(orders).toHaveLength(sentBefore);
    expect(ended).toBe(2);
    // An answer not in the readiness shape is not believed.
    answer = () => ({
      ok: true,
      readiness: { status: 'authenticated', message: 'ok', models: [], extra: 1 },
    });
    expect((await r.probe('claude', '/usr/bin/claude', dir, null)).status).toBe('unknown');
  });
});

describe('SplitRuntime.setProbeEnv', () => {
  it('takes the gateway probe once it is up, and uses it from then on', async () => {
    const r = runtime();
    const login = { provider: 'claude', kind: 'api-key', credential: 'sk-ant-real' } as never;
    // Before the gateway is up: a login check sends nothing.
    expect((await r.probe('claude', '/usr/bin/claude', dir, login)).status).toBe('unknown');
    expect(orders).toEqual([]);
    let ended = 0;
    r.setProbeEnv(async () => ({
      env: { ANTHROPIC_API_KEY: 'swpg_probe_0123456789abcdef' },
      done: () => void ended++,
    }));
    answer = () => ({
      ok: true,
      readiness: { status: 'authenticated', message: 'ok', models: [] },
    });
    expect((await r.probe('claude', '/usr/bin/claude', dir, login)).status).toBe('authenticated');
    expect(orders).toHaveLength(1);
    expect(ended).toBe(1);
  });
});
