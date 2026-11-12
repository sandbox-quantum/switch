import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Launcher, type LauncherDeps, type PushOutcome, type SpawnRecorder } from './launcher';
import { encodeLine, type LauncherReport } from './launcher-protocol';
import type { ProcessEntry } from './owner-marker';
import type { AgentRunner, LaunchOptions } from './runtime';
import { buildWatcherTemplate } from './template';

const X = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
const Y = '148578ff-daef-412f-9ade-2f5ec48420db';
const MX = 'a'.repeat(64);
const MY = 'b'.repeat(64);

let dir: string;
let proc: string;
let sent: LauncherReport[];
let logged: [string, Record<string, string | number>][];
let launched: [string, LaunchOptions][];
let signals: [number, string][];
let closed: number;
let pushed: [string, string][];
let warmed: [string, string][];
/** The pid the fake runner "spawns" each agent's host as. */
let spawnPids: Record<string, number>;
let pushOutcome: PushOutcome;
let pushedTo: { pid: number; key: Buffer }[];
/** The fake process table: entries carry the marker in `marker`, resolved per call. */
let table: (ProcessEntry & { marker: string | null; cmd: string })[];

const root = (agentId: string) => join(dir, 'watchers', agentId);

function launcher(over: Partial<LauncherDeps> = {}): Launcher {
  let spawned: SpawnRecorder = () => {};
  const runner: AgentRunner = {
    observe: async () => ({
      alive: true,
      configured: null,
      flags: null,
      health: null,
      failure: null,
      takenOver: null,
      outdated: false,
    }),
    launch: async (agentId, _template, options) => {
      launched.push([agentId, options]);
      spawned(agentId, spawnPids[agentId] ?? 99, Buffer.alloc(32, launched.length));
    },
    stop: async () => {},
    close: async () => {},
  };
  const deps: LauncherDeps = {
    send: (line) => void sent.push(JSON.parse(line) as LauncherReport),
    runner: (_markers, recorder) => {
      spawned = recorder;
      return runner;
    },
    credentialsPath: (agentId) => join(dir, 'agents', agentId, 'credentials.json'),
    proc: { procRoot: proc, self: 1 },
    list: async (markers, agentIds) => {
      const ownerOf = markers.matcher(agentIds);
      return table.map(({ marker, cmd: _cmd, ...entry }) => ({
        ...entry,
        owner: marker ? ownerOf(marker) : null,
      }));
    },
    signal: (pid, name) => {
      signals.push([pid, name]);
      if (name === 'SIGKILL') table = table.filter((entry) => entry.pid !== pid);
    },
    version: '0.2.0',
    bundle: 'bundle-1',
    now: () => 1_000,
    log: (event, fields) => void logged.push([event, fields]),
    pushTicket: async (agentId, ticket, host) => {
      pushed.push([agentId, ticket]);
      pushedTo.push(host);
      return pushOutcome;
    },
    probe: async (provider) => ({ status: 'authenticated', message: provider, models: [] }),
    warm: async (agentId, roomId) => void warmed.push([agentId, roomId]),
    memoryNotice: async () => 3,
    workspacesRoot: join(dir, 'workspaces'),
    dataRoot: join(dir, 'agents'),
    onClosed: () => void closed++,
    ...over,
  };
  return new Launcher(deps);
}

function process(
  pid: number,
  ppid: number,
  startTicks: number,
  marker: string | null,
  cmd: string,
  anonKiB: number
) {
  table.push({ pid, ppid, startTicks, owner: null, marker, cmd });
  mkdirSync(join(proc, String(pid)), { recursive: true });
  writeFileSync(
    join(proc, String(pid), 'smaps'),
    `00-01 rw-p 00000000 00:00 0\nAnonymous: ${anonKiB} kB\n`
  );
}

function launchOrder(agentId: string, marker: string, id: number) {
  return {
    kind: 'launch' as const,
    id,
    agentId,
    launchId: id,
    template: buildWatcherTemplate({
      agentId,
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
      credentialsPath: join(dir, 'agents', agentId, 'credentials.json'),
      binaryPath: '/usr/bin/claude',
    }) as unknown as Record<string, unknown>,
    marker,
    ticket: 'c'.repeat(32),
    credentials: { endpoint: 'http://127.0.0.1:1', token: 'swlr_x', hub: 'ws://127.0.0.1:1/hub' },
    restart: false,
    replaceIdentity: false,
    clearTakenOver: false,
  };
}

/**
 * Waits until the launcher has gone quiet: nothing new sent, logged or pushed
 * for 60 ms (up to 3 s), so a loaded runner can't make an order look unanswered.
 */
async function settle(): Promise<void> {
  let last = -1;
  let quietFor = 0;
  for (let waited = 0; waited < 3_000; waited += 10) {
    const now = sent.length + logged.length + pushed.length + launched.length + signals.length;
    if (now === last) {
      quietFor += 10;
      if (quietFor >= 60) return;
    } else {
      last = now;
      quietFor = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Waits for the reply to order `id`, however long a loaded runner takes (up to 5 s). */
async function replied(id: number): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 10) {
    if (sent.some((report) => report.kind === 'reply' && report.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No reply to order ${id}.`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'launcher-'));
  proc = join(dir, 'proc');
  sent = [];
  logged = [];
  launched = [];
  signals = [];
  closed = 0;
  pushed = [];
  warmed = [];
  spawnPids = { [X]: 10, [Y]: 20 };
  pushOutcome = 'taken';
  pushedTo = [];
  table = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Launcher', () => {
  it('says hello with a fresh boot id', () => {
    const l = launcher();
    l.start();
    expect(sent).toEqual([
      { kind: 'hello', version: '0.2.0', bundle: 'bundle-1', bootId: l.bootId },
    ]);
    expect(l.bootId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('launches an ordered host isolated, writes its credentials with no login, and hands its ticket to the host', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    expect(sent).toEqual([{ kind: 'reply', id: 1, ok: true }]);
    expect(launched).toEqual([
      [X, { isolation: 'isolated', restart: false, replaceIdentity: false, clearTakenOver: false }],
    ]);
    const written = JSON.parse(readFileSync(join(dir, 'agents', X, 'credentials.json'), 'utf8'));
    expect(written.providerLogin).toBeNull();
    expect(written.env.SWITCH_AGENT_ID).toBe(X);
    expect(pushed).toEqual([[X, 'c'.repeat(32)]]);
    l.feed(
      Buffer.from(
        encodeLine({ kind: 'ticket', id: 9, agentId: X, launchId: 1, ticket: 'd'.repeat(32) })
      )
    );
    await settle();
    expect(pushed).toEqual([
      [X, 'c'.repeat(32)],
      [X, 'd'.repeat(32)],
    ]);
  });

  it('makes a launch’s directory only inside the workspaces folder; inside the data folder it must exist', async () => {
    const l = launcher();
    const inside = join(dir, 'workspaces', 'a');
    const inData = join(dir, 'agents', 'projects', 'b');
    const outside = join(dir, 'elsewhere');
    l.feed(Buffer.from(encodeLine({ ...launchOrder(X, MX, 1), directory: inside })));
    l.feed(Buffer.from(encodeLine({ ...launchOrder(Y, MY, 2), directory: inData })));
    l.feed(Buffer.from(encodeLine({ ...launchOrder(X, MX, 3), directory: outside })));
    await settle();
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(inData)).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(launched).toHaveLength(2);
    expect(sent).toContainEqual({ kind: 'reply', id: 3, ok: false, code: 'bad_directory' });
  });

  it('warms a room and passes on the memory line through the host, only for an agent it launched', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine({ kind: 'warm', id: 1, agentId: X, roomId: '!r:x' })));
    await settle();
    expect(sent).toEqual([{ kind: 'reply', id: 1, ok: false, code: 'unknown_agent' }]);
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 2))));
    await settle();
    sent = [];
    l.feed(Buffer.from(encodeLine({ kind: 'warm', id: 3, agentId: X, roomId: '!r:x' })));
    l.feed(Buffer.from(encodeLine({ kind: 'memory_notice', id: 4, agentId: X })));
    await settle();
    expect(warmed).toEqual([[X, '!r:x']]);
    expect(sent).toEqual([
      { kind: 'reply', id: 3, ok: true },
      { kind: 'reply', id: 4, ok: true, told: 3 },
    ]);
  });

  it('refuses a bad template, and logs an order it cannot read by code only', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine({ ...launchOrder(X, MX, 2), template: { nope: true } })));
    l.feed(Buffer.from('{"kind":"exec","cmd":"id"}\n'));
    await settle();
    expect(sent).toEqual([{ kind: 'reply', id: 2, ok: false, code: 'bad_template' }]);
    expect(launched).toEqual([]);
    expect(logged).toEqual([['refused_order', { reason: 'bad_shape' }]]);
  });

  it('measures by first sight: a tool under X carrying Y’s marker counts to X; a stray with Y’s marker is disputed for Y', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1)) + encodeLine(launchOrder(Y, MY, 2))));
    await settle();
    process(10, 1, 100, MX, `node bundle.mjs ${root(X)} --watch`, 1000); // X's host
    process(11, 10, 110, MX, 'claude', 2000); // X's tool
    process(12, 10, 120, MY, 'sneaky', 4000); // under X, carrying Y's marker
    process(20, 1, 105, MY, `node bundle.mjs ${root(Y)} --watch`, 500); // Y's host
    process(30, 1, 130, MY, 'stray', 8000); // first seen outside every tree
    sent = [];
    await l.measure();
    expect(sent).toEqual([
      {
        kind: 'measure',
        at: 1_000,
        agents: {
          [X]: { bytes: (1000 + 2000 + 4000) * 1024, processes: 3, disputedBytes: 0 },
          [Y]: { bytes: (500 + 8000) * 1024, processes: 2, disputedBytes: 8000 * 1024 },
        },
        strangers: { processes: 0, bytes: 0, ended: 0 },
      },
    ]);
  });

  it("ends X's tree, its Y-marked tool included, and never Y's host (C8a); freeze spares the host", async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1)) + encodeLine(launchOrder(Y, MY, 2))));
    await replied(1);
    await replied(2);
    process(10, 1, 100, MX, `node bundle.mjs ${root(X)}`, 1);
    process(12, 10, 120, MY, 'sneaky', 1);
    process(20, 1, 105, MY, `node bundle.mjs ${root(Y)}`, 1);
    sent = [];
    l.feed(Buffer.from(encodeLine({ kind: 'freeze', id: 7, agentId: X })));
    await replied(7);
    expect(signals).toEqual([[12, 'SIGSTOP']]);
    signals = [];
    l.feed(Buffer.from(encodeLine({ kind: 'end', id: 8, agentId: X })));
    await replied(8);
    expect(
      signals
        .filter(([, name]) => name === 'SIGKILL')
        .map(([pid]) => pid)
        .sort((a, b) => a - b)
    ).toEqual([10, 12]);
    expect(table.map((entry) => entry.pid)).toEqual([20]);
    expect(sent.at(-1)).toMatchObject({ kind: 'reply', id: 8, ok: true, counts: { signalled: 2 } });
  });

  it('reports a host that exited, and never starts one itself; once closed it sends nothing', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 3))));
    await settle();
    sent = [];
    l.hostExited(X, 'gone');
    expect(sent).toEqual([{ kind: 'exited', agentId: X, launchId: 3, reason: 'gone' }]);
    expect(launched).toHaveLength(1);
    l.close();
    l.hostExited(X, 'gone');
    expect(closed).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe('Launcher: spawn and file safety', () => {
  it('takes as the host only the process it spawned, by pid and start time, never an older marked one', async () => {
    const l = launcher();
    // An older process carrying X's marker and naming X's root: the old guess would take it.
    process(5, 1, 50, MX, `node bundle.mjs ${root(X)} --watch`, 1);
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    process(10, 1, 100, MX, `node bundle.mjs ${root(X)} --watch`, 1); // the spawned host
    process(11, 10, 110, MX, 'tool', 1);
    signals = [];
    l.feed(Buffer.from(encodeLine({ kind: 'freeze', id: 2, agentId: X })));
    await settle();
    // The host is spared; the impostor (disputed, X's marker) and the tool are frozen.
    expect(signals.map(([pid]) => pid).sort((a, b) => a - b)).toEqual([5, 11]);
  });

  it('never takes a reused pid for the host: the first sighting must be this launcher’s own child', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    process(10, 7, 100, MX, 'not ours', 1); // pid 10, but its parent isn't the launcher
    signals = [];
    l.feed(Buffer.from(encodeLine({ kind: 'freeze', id: 2, agentId: X })));
    await settle();
    // Not the host, so not spared: frozen as a disputed process with X's marker.
    expect(signals).toEqual([[10, 'SIGSTOP']]);
  });

  it('ends a stranger seen in two scans in a row, counts its bytes to the box, and says so once', async () => {
    const l = launcher();
    process(1, 0, 1, null, 'tini', 1); // never a stranger
    process(40, 1, 400, null, 'stray', 300);
    sent = [];
    await l.measure();
    expect(sent.at(-1)).toMatchObject({ strangers: { processes: 1, bytes: 300 * 1024, ended: 0 } });
    expect(signals).toEqual([]);
    await l.measure();
    expect(signals).toEqual([[40, 'SIGKILL']]);
    expect(sent.at(-1)).toMatchObject({ strangers: { processes: 1, ended: 1 } });
    expect(logged.filter(([event]) => event === 'stranger_ended')).toEqual([
      ['stranger_ended', { pid: 40, ended: 1 }],
    ]);
  });

  it('ends a host that does not confirm its push key in time, and reports it for the controller to relaunch', async () => {
    pushOutcome = 'not_taken';
    const l = launcher({ confirmMs: 30 });
    process(10, 1, 100, MX, 'host', 1); // the host the launch spawns, as pid 10
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    expect(pushedTo[0]).toEqual({ pid: 10, key: Buffer.alloc(32, 1) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(signals).toContainEqual([10, 'SIGKILL']);
    expect(sent.at(-1)).toEqual({ kind: 'exited', agentId: X, launchId: 1, reason: 'unconfirmed' });
  });

  it('a confirmed host is left alone', async () => {
    const l = launcher({ confirmMs: 30 });
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sent.filter((report) => report.kind === 'exited')).toEqual([]);
  });

  it('pushes nothing to a control port not the host’s own, and ends the host', async () => {
    pushOutcome = 'wrong_port';
    const l = launcher();
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1))));
    await settle();
    await settle();
    expect(sent.at(-1)).toEqual({ kind: 'exited', agentId: X, launchId: 1, reason: 'wrong_port' });
  });

  it('hands a ticket only to a host it spawned', async () => {
    const l = launcher();
    l.feed(
      Buffer.from(
        encodeLine({ kind: 'ticket', id: 1, agentId: X, launchId: 1, ticket: 'd'.repeat(32) })
      )
    );
    await settle();
    expect(pushed).toEqual([]);
    expect(logged).toContainEqual(['ticket_no_host', { agentId: X }]);
  });
});

describe('Launcher: operator exec on test boxes', () => {
  function execTree() {
    process(1, 0, 1, null, 'tini', 1);
    process(50, 0, 500, null, 'sh', 100); // the runtime's exec
    process(51, 50, 510, null, 'ps', 200); // and what it runs
    writeFileSync(join(proc, '50', 'comm'), 'sh\n');
  }

  it('leaves an exec’d shell and its child running with the setting on, counts them, and says so once', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine({ kind: 'settings', id: 1, operatorExec: true })));
    await settle();
    execTree();
    sent = [];
    await l.measure();
    await l.measure();
    expect(signals).toEqual([]);
    expect(sent.at(-1)).toMatchObject({
      strangers: { processes: 0 },
      operator: { processes: 2, bytes: 300 * 1024 },
    });
    expect(logged.filter(([event]) => event === 'operator_exec')).toEqual([
      ['operator_exec', { pid: 50, command: 'sh' }],
    ]);
  });

  it('ends the same tree as strangers with the setting off', async () => {
    const l = launcher();
    execTree();
    await l.measure();
    await l.measure();
    expect(signals.map(([pid]) => pid).sort((a, b) => a - b)).toEqual([50, 51]);
  });
});

describe('Launcher: other requests', () => {
  it('refuses a working directory outside the agents’ folders, before anything starts', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine({ ...launchOrder(X, MX, 1), directory: '/etc' })));
    await settle();
    expect(sent).toEqual([{ kind: 'reply', id: 1, ok: false, code: 'bad_directory' }]);
    expect(launched).toEqual([]);
  });

  it('answers observe with only what the controller acts on', async () => {
    const l = launcher();
    l.feed(Buffer.from(encodeLine({ kind: 'observe', id: 1, agentId: X })));
    await settle();
    expect(sent).toEqual([
      {
        kind: 'reply',
        id: 1,
        ok: true,
        observation: { alive: true, health: null, failure: null, outdated: false },
      },
    ]);
  });

  it('runs a probe here with the gateway’s probe environment', async () => {
    const l = launcher();
    l.feed(
      Buffer.from(
        encodeLine({
          kind: 'probe',
          id: 1,
          provider: 'claude',
          binaryPath: '/usr/bin/claude',
          env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'swpg_x' },
        })
      )
    );
    await settle();
    expect(sent).toEqual([
      {
        kind: 'reply',
        id: 1,
        ok: true,
        readiness: { status: 'authenticated', message: 'claude', models: [] },
      },
    ]);
  });
});

describe('the agents’ disk', () => {
  it('measures its own data folder (the agents’ volume) and answers with numbers only', async () => {
    const asked: string[] = [];
    const l = launcher({
      statfs: async (path) => {
        asked.push(path);
        return { bavail: 3_000_000, blocks: 3_840_000, bsize: 4096 };
      },
    });
    l.feed(Buffer.from(encodeLine({ kind: 'disk', id: 4 })));
    await settle();
    expect(asked).toEqual([join(dir, 'agents')]);
    expect(sent).toEqual([
      { kind: 'reply', id: 4, ok: true, disk: { free: 12_288_000_000, total: 15_728_640_000 } },
    ]);
  });

  it('never says more is free than the disk holds', async () => {
    const l = launcher({ statfs: async () => ({ bavail: 10, blocks: 5, bsize: 1 }) });
    l.feed(Buffer.from(encodeLine({ kind: 'disk', id: 1 })));
    await settle();
    expect(sent).toEqual([{ kind: 'reply', id: 1, ok: true, disk: { free: 5, total: 5 } }]);
  });

  it('fails, with a code only, when there is no data folder or it can’t be measured', async () => {
    launcher({ dataRoot: undefined }).feed(Buffer.from(encodeLine({ kind: 'disk', id: 1 })));
    launcher({
      statfs: async () => {
        throw new Error('EACCES: /data/agents secret-path');
      },
    }).feed(Buffer.from(encodeLine({ kind: 'disk', id: 2 })));
    await settle();
    expect(sent).toEqual([
      { kind: 'reply', id: 1, ok: false, code: 'failed' },
      { kind: 'reply', id: 2, ok: false, code: 'failed' },
    ]);
    expect(JSON.stringify(logged)).not.toContain('secret-path');
  });
});

describe('Launcher.checkHosts', () => {
  it('reports a host that died once, not one stopped on order, and never starts either', async () => {
    let alive = true;
    const l = launcher({
      runner: (_markers, recorder) => ({
        observe: async () => ({
          alive,
          configured: null,
          flags: null,
          health: null,
          failure: null,
          takenOver: null,
          outdated: false,
        }),
        launch: async (agentId, _t, options) => {
          launched.push([agentId, options]);
          recorder(agentId, spawnPids[agentId]!, Buffer.alloc(32, 1));
        },
        stop: async () => {},
        close: async () => {},
      }),
    });
    l.feed(Buffer.from(encodeLine(launchOrder(X, MX, 1)) + encodeLine(launchOrder(Y, MY, 2))));
    await settle();
    await l.checkHosts(); // both seen alive
    l.feed(Buffer.from(encodeLine({ kind: 'stop', id: 3, agentId: Y, wait: true, asked: true })));
    await settle();
    sent = [];
    alive = false;
    await l.checkHosts();
    await l.checkHosts();
    expect(sent).toEqual([{ kind: 'exited', agentId: X, launchId: 1, reason: 'gone' }]);
    expect(launched).toHaveLength(2);
  });
});
