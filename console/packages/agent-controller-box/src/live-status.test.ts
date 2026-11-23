import {
  chmodSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoxValveStatus } from '@switch-console/agent-providers-box';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkedLiveStatusDir,
  liveStatusDirOrOff,
  MAX_CONVERSATIONS_PER_AGENT,
  eventsSince,
  formatEventsSince,
  formatLiveStatus,
  gatherLiveExtras,
  imageDigestFromEnv,
  LIVE_STATUS_EVERY_MS,
  LIVE_STATUS_FILE,
  LIVE_STATUS_STALE_MS,
  type LiveStatusExtras,
  type LiveStatusInputs,
  LiveStatusWriter,
  liveStatusDirFromEnv,
  liveStatusFrom,
  readLiveStatus,
  writeLiveStatus,
} from './live-status';
import { dataLayout } from './paths';
import type { StatusReport } from './schemas';

const AGENT_A = '7b1e5c0a-1111-4222-8333-944455556666';
const AGENT_B = '0c2d3e4f-5555-4666-8777-988899990000';
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const T0 = Date.parse('2026-10-28T15:00:00.000Z');

function agent(
  agentId: string,
  process: StatusReport['agents'][number]['process'],
  extra: Partial<StatusReport['agents'][number]> = {}
): StatusReport['agents'][number] {
  return {
    agent_id: agentId,
    applied_revision: 4,
    process,
    attached: process === 'running',
    sessions: { active: process === 'running' ? 1 : 0, ids: ['session-should-not-show'] },
    restarts_10m: 0,
    oom_kills: 0,
    directory: '/workspaces/a-path-that-should-not-show',
    since: '2026-10-28T14:00:00.000Z',
    ...extra,
  } as StatusReport['agents'][number];
}

function report(agents: StatusReport['agents'], machine: Partial<StatusReport['machine']> = {}) {
  return {
    observed_at: '2026-10-28T15:00:00.000Z',
    controller: {
      version: '0.9.1-l2fix9',
      protocol: 1,
      assignment_revision: 12,
      updated_by: 'self',
    },
    machine: {
      platform: 'linux',
      disk_free_bytes: 1,
      disk_total_bytes: 2,
      mem_free_bytes: 1,
      mem_total_bytes: 2,
      sessions_running: 1,
      sessions_max: 12,
      workspaces_dir: '/workspaces',
      ...machine,
    },
    providers: [],
    tools: [],
    agents,
  } as unknown as Omit<StatusReport, 'seq'>;
}

const VALVE_ON: BoxValveStatus = {
  enabled: true,
  cap: 12,
  awake: 2,
  starting: 1,
  waiting: 0,
  waitingForRoom: 0,
};

function inputs(overrides: Partial<LiveStatusInputs> = {}): LiveStatusInputs {
  return {
    report: report([
      agent(AGENT_A, 'running', { waiting_for_room: { count: 2, oldest_since: null } }),
      agent(AGENT_B, 'stopped'),
    ]),
    assigned: [
      { agentId: AGENT_A, desired: 'running' },
      { agentId: AGENT_B, desired: 'running' },
    ],
    restKind: (agentId) => (agentId === AGENT_B ? 'resting' : null),
    hubHosts: new Map([[AGENT_A, { since: T0 - 5_000, onValve: false }]]),
    valve: VALVE_ON,
    formulaCap: 12,
    guard: { boxLimit: 6 * 1024 ** 3, backstop: 0.92, share: 0.6 },
    restAfterMs: 600_000,
    lastSyncAt: T0 - 30_000,
    imageDigest: DIGEST,
    flags: { optimizeForSize: true, nodeOptionsSet: false },
    launcherMode: false,
    ...overrides,
  };
}

const EXTRAS: LiveStatusExtras = {
  box: { bytes: 2 * 1024 ** 3, shmem: 1024 },
  controllerAnonBytes: 120 * 1024 ** 2,
  conversations: [
    { id: 'aaaa1111-2222', agentId: AGENT_A, state: 'busy' },
    { id: 'bbbb1111-2222', agentId: AGENT_A, state: 'parked' },
  ],
  claudeProcesses: 1,
  hostProcesses: 1,
  byAgent: new Map([
    [
      AGENT_A,
      { claudeProcesses: 1, hostProcesses: 1, loginCopies: 3, newestLoginCopyAt: T0 - 60_000 },
    ],
    [
      AGENT_B,
      { claudeProcesses: 0, hostProcesses: 0, loginCopies: 1, newestLoginCopyAt: T0 - 90_000 },
    ],
  ]),
};

describe('liveStatusFrom', () => {
  it('builds platform’s readings: the common block, per agent, and totals', () => {
    const status = liveStatusFrom(inputs(), EXTRAS, {
      startedAt: T0 - 3_600_000,
      now: T0,
      peakAwake: 4,
    });
    expect(status.version).toBe(1);
    expect(status.controller).toEqual({
      version: '0.9.1-l2fix9',
      image_digest: DIGEST,
      started_at: '2026-10-28T14:00:00.000Z',
      assignment_revision: 12,
      last_sync_at: '2026-10-28T14:59:30.000Z',
      anon_bytes: 120 * 1024 ** 2,
      optimize_for_size: true,
      node_options_set: false,
      launcher_mode: false,
    });
    expect(status.conversations).toEqual([
      { id: 'aaaa1111', agent: '7b1e5c0a', state: 'busy', since: '2026-10-28T15:00:00.000Z' },
      { id: 'bbbb1111', agent: '7b1e5c0a', state: 'parked', since: '2026-10-28T15:00:00.000Z' },
    ]);
    expect(status.events).toEqual([]);
    expect(status.box).toEqual({
      memory_limit_bytes: 6 * 1024 ** 3,
      memory_bytes: 2 * 1024 ** 3,
      memory_percent: 33.3,
      shmem_bytes: 1024,
      claude_processes: 1,
      host_processes: 1,
    });
    expect(status.valve).toMatchObject({
      enabled: true,
      cap: 12,
      formula_cap: 12,
      awake: 2,
      peak_awake: 4,
    });
    expect(status.guard).toEqual({ enabled: true, backstop: 0.92, share: 0.6, noting: false });
    expect(status.launcher).toBeNull();
    expect(status.agents).toEqual([
      {
        id: '0c2d3e4f',
        desired: 'running',
        process: 'stopped',
        resting: true,
        out_of_memory: false,
        rest_after_ms: 600_000,
        on_hub: false,
        on_hub_since: null,
        valve_fallback: null,
        sessions_active: 0,
        waiting_for_room: 0,
        claude_processes: 0,
        host_processes: 0,
        login_copies: 1,
        newest_login_copy_at: '2026-10-28T14:58:30.000Z',
      },
      {
        id: '7b1e5c0a',
        desired: 'running',
        process: 'running',
        resting: false,
        out_of_memory: false,
        rest_after_ms: 600_000,
        on_hub: true,
        on_hub_since: '2026-10-28T14:59:55.000Z',
        valve_fallback: true,
        sessions_active: 1,
        waiting_for_room: 2,
        claude_processes: 1,
        host_processes: 1,
        login_copies: 3,
        newest_login_copy_at: '2026-10-28T14:59:00.000Z',
      },
    ]);
    expect(status.totals).toMatchObject({ desired_running: 2, resting: 1, on_hub: 1 });
    expect(status.totals.process.running).toBe(1);
  });

  it('shows an unbounded or switched-off valve and guard without figures', () => {
    const status = liveStatusFrom(
      inputs({
        valve: { ...VALVE_ON, enabled: false, cap: Number.POSITIVE_INFINITY },
        formulaCap: null,
        guard: null,
      }),
      EXTRAS,
      { startedAt: T0, now: T0, peakAwake: 0 }
    );
    expect(status.valve.cap).toBeNull();
    expect(status.guard).toEqual({ enabled: false, backstop: null, share: null, noting: false });
    expect(status.box.memory_limit_bytes).toBeNull();
    expect(status.agents.every((entry) => entry.valve_fallback === null)).toBe(true);
  });
});

describe('the environment', () => {
  it('takes the folder only when absolute, and the digest only when it is one', () => {
    expect(liveStatusDirFromEnv({})).toBeNull();
    expect(liveStatusDirFromEnv({ SWITCH_CONTROLLER_LIVE_STATUS_DIR: '/tmp/live' })).toBe(
      '/tmp/live'
    );
    expect(() => liveStatusDirFromEnv({ SWITCH_CONTROLLER_LIVE_STATUS_DIR: 'relative' })).toThrow();
    expect(imageDigestFromEnv({ SWITCH_IMAGE_DIGEST: DIGEST })).toBe(DIGEST);
    expect(imageDigestFromEnv({ SWITCH_IMAGE_DIGEST: 'latest' })).toBeNull();
  });
});

describe('gatherLiveExtras', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-extras-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function proc(pid: number, comm: string, cmdline: string[]) {
    mkdirSync(join(dir, 'proc', String(pid)), { recursive: true });
    writeFileSync(join(dir, 'proc', String(pid), 'comm'), `${comm}\n`);
    writeFileSync(join(dir, 'proc', String(pid), 'cmdline'), `${cmdline.join('\0')}\0`);
  }

  it('counts Claude and agent hosts on the box, and an agent’s login copies by their times only', async () => {
    proc(10, 'claude', ['claude', '--print']);
    proc(11, 'node', ['node', '/opt/switch/shared-host.mjs']);
    proc(12, 'node', ['node', '/opt/switch/agent-controller.mjs', 'run']);
    writeFileSync(join(dir, 'proc', 'meminfo'), 'AnonPages:  1024 kB\nShmem:  0 kB\n');
    const layout = dataLayout(join(dir, 'data'));
    mkdirSync(join(layout.watcherRoot(AGENT_A), 'provider-home'), { recursive: true });
    mkdirSync(layout.agentDir(AGENT_A), { recursive: true });
    writeFileSync(layout.agentCredentials(AGENT_A), '{"token":"swlr_secret"}');
    utimesSync(layout.agentCredentials(AGENT_A), new Date(T0), new Date(T0));

    const extras = await gatherLiveExtras({
      agentIds: [AGENT_A],
      markers: null,
      layout,
      health: async () => ({
        sessions: {
          's-busy': 'active',
          's-idle': 'active',
          's-wake': 'waking',
          's-park': 'parked',
        },
        busy: ['s-busy'],
      }),
      procRoot: join(dir, 'proc'),
    });
    expect(extras.conversations.map((c) => [c.id, c.state])).toEqual([
      ['s-busy', 'busy'],
      ['s-idle', 'awake'],
      ['s-wake', 'waking'],
      ['s-park', 'parked'],
    ]);
    expect(extras.claudeProcesses).toBe(1);
    expect(extras.hostProcesses).toBe(1);
    // With no markers, whose a process is can't be proved.
    expect(extras.byAgent.get(AGENT_A)).toMatchObject({
      claudeProcesses: null,
      hostProcesses: null,
      loginCopies: 2,
    });
    expect(extras.byAgent.get(AGENT_A)!.newestLoginCopyAt).toBeGreaterThanOrEqual(T0);
  });

  it('gives no process counts where there is no /proc', async () => {
    const extras = await gatherLiveExtras({
      agentIds: [],
      markers: null,
      layout: dataLayout(join(dir, 'data')),
      health: async () => null,
      procRoot: join(dir, 'no-proc'),
    });
    expect(extras.claudeProcesses).toBeNull();
    expect(extras.hostProcesses).toBeNull();
  });
});

describe('the live status file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-status-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const gather = async () => EXTRAS;

  it('is written 0600, with ids cut to 8, and holds no session, path, note or full id', async () => {
    const path = join(dir, LIVE_STATUS_FILE);
    await writeLiveStatus(
      path,
      liveStatusFrom(
        inputs({
          report: report([agent(AGENT_A, 'running')], {
            memory_note: 'unexplained',
            memory_note_box_bytes: 5_000_000_000,
          }),
        }),
        EXTRAS,
        { startedAt: T0, now: T0, peakAwake: 0 }
      )
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    for (const secret of [AGENT_A, 'session-should-not-show', 'a-path-that-should-not-show'])
      expect(text).not.toContain(secret);
    expect(text).toContain('"7b1e5c0a"');
  });

  it('is rewritten at most every ten seconds, and keeps the peak awake between writes', async () => {
    let now = T0;
    const writer = new LiveStatusWriter({
      dir,
      startedAt: T0,
      now: () => now,
      gather,
      warn: () => {},
    });
    await writer.observe(inputs({ valve: { ...VALVE_ON, awake: 1 } }));
    now += 5_000;
    await writer.observe(inputs({ valve: { ...VALVE_ON, awake: 7 } }));
    let read = await readLiveStatus(dir, now);
    expect(read.kind === 'fresh' && read.status.valve.awake).toBe(1);
    now += LIVE_STATUS_EVERY_MS;
    await writer.observe(inputs({ valve: { ...VALVE_ON, awake: 2 } }));
    read = await readLiveStatus(dir, now);
    expect(read.kind === 'fresh' && read.status.valve.awake).toBe(2);
    expect(read.kind === 'fresh' && read.status.valve.peak_awake).toBe(7);
  });

  it('logs a failed write once, until one succeeds, and never throws', async () => {
    const warnings: string[] = [];
    let now = T0;
    const writer = new LiveStatusWriter({
      dir: join(dir, 'missing-folder'),
      startedAt: T0,
      now: () => now,
      gather,
      warn: (message) => warnings.push(message),
    });
    await writer.observe(inputs());
    now += LIVE_STATUS_EVERY_MS;
    await writer.observe(inputs());
    expect(warnings).toEqual(['Could not write the live status file']);
  });

  it('reads as fresh, then stale after a minute', async () => {
    await writeLiveStatus(
      join(dir, LIVE_STATUS_FILE),
      liveStatusFrom(inputs(), EXTRAS, { startedAt: T0, now: T0, peakAwake: 0 })
    );
    expect((await readLiveStatus(dir, T0 + 5_000)).kind).toBe('fresh');
    expect((await readLiveStatus(dir, T0 + LIVE_STATUS_STALE_MS + 1)).kind).toBe('stale');
  });

  it('refuses a missing file, a symlink, an oversized file and the wrong shape', async () => {
    expect(await readLiveStatus(dir, T0)).toEqual({ kind: 'missing' });

    writeFileSync(join(dir, 'elsewhere.json'), '{}');
    symlinkSync(join(dir, 'elsewhere.json'), join(dir, LIVE_STATUS_FILE));
    expect(await readLiveStatus(dir, T0)).toEqual({
      kind: 'unreadable',
      why: 'not a regular file',
    });
    rmSync(join(dir, LIVE_STATUS_FILE));

    writeFileSync(join(dir, LIVE_STATUS_FILE), 'x'.repeat(300 * 1024));
    expect(await readLiveStatus(dir, T0)).toEqual({ kind: 'unreadable', why: 'too large' });

    const good = liveStatusFrom(inputs(), EXTRAS, { startedAt: T0, now: T0, peakAwake: 0 });
    writeFileSync(join(dir, LIVE_STATUS_FILE), JSON.stringify({ ...good, version: 2 }));
    expect(await readLiveStatus(dir, T0)).toEqual({
      kind: 'unreadable',
      why: 'not the live status shape',
    });
    writeFileSync(
      join(dir, LIVE_STATUS_FILE),
      JSON.stringify({ ...good, agents: [{ ...good.agents[0], id: AGENT_A }] })
    );
    expect((await readLiveStatus(dir, T0)).kind).toBe('unreadable');
  });
});

describe('the valve memory problem in the live status', () => {
  it('is null when readings are fine, and shows "memory unprotected" from the report otherwise', () => {
    const fine = liveStatusFrom(inputs(), EXTRAS, { startedAt: T0, now: T0, peakAwake: 0 });
    expect(fine.valve.memory).toBeNull();
    expect(formatLiveStatus(fine, 0, T0)).not.toContain('memory=unprotected');
    const unprotected = liveStatusFrom(
      inputs({ report: report([agent(AGENT_A, 'running')], { valve_memory: 'unprotected' }) }),
      EXTRAS,
      { startedAt: T0, now: T0, peakAwake: 0 }
    );
    expect(unprotected.valve.memory).toBe('unprotected');
    expect(formatLiveStatus(unprotected, 0, T0)).toContain(' memory=unprotected');
    const failing = liveStatusFrom(
      inputs({ report: report([agent(AGENT_A, 'running')], { valve_memory: 'failing' }) }),
      EXTRAS,
      { startedAt: T0, now: T0, peakAwake: 0 }
    );
    expect(failing.valve.memory).toBe('failing');
  });
});

describe('formatLiveStatus', () => {
  it('prints one line per reading, and one per agent', () => {
    const status = liveStatusFrom(inputs(), EXTRAS, {
      startedAt: T0 - 3_600_000,
      now: T0,
      peakAwake: 3,
    });
    const lines = formatLiveStatus(status, 4_000, T0).split('\n');
    expect(lines[0]).toBe(
      'controller: version=0.9.1-l2fix9 up=3600s file_age=4s revision=12 last_sync=30s image=sha256:abababababab'
    );
    expect(lines).toContain('box: memory=2048MiB (33.3%) limit=6144MiB claude=1 hosts=1');
    expect(lines).toContain(
      'valve: on cap=12 formula=12 awake=2 peak=3 starting=1 waiting=0 waiting_for_room=0 hosts=- joined=-'
    );
    expect(lines).toContain('guard: on backstop=0.92 share=0.6 noting=no');
    expect(lines).toContain('conversations: waking=0 awake=0 busy=1 parked=1');
    expect(lines).toContain(
      'controller_process: anon=120MiB optimize_for_size=yes node_options_set=no launcher_mode=no'
    );
    expect(lines).toContain(
      'agent 7b1e5c0a: desired=running process=running resting=no on_hub=yes fallback=yes sessions=1 claude=1 hosts=1 login_copies=3'
    );
  });
});

describe('conversations and events in the writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-conv-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a conversation’s since until its state changes, and carries the events', async () => {
    let now = T0;
    let state: 'busy' | 'parked' = 'busy';
    const writer = new LiveStatusWriter({
      dir,
      startedAt: T0,
      now: () => now,
      gather: async () => ({
        ...EXTRAS,
        conversations: [{ id: 'conv-1', agentId: AGENT_A, state }],
      }),
      events: () => ({
        events: [
          {
            at: T0 + 1_000,
            kind: 'parked_for_cap',
            agent: '7b1e5c0a',
            conversation: 'conv-1',
            reason: null,
            count: 1,
          },
          {
            at: T0 + 2_000,
            kind: 'starts_refused',
            agent: null,
            conversation: null,
            reason: 'cap',
            count: 4,
          },
        ],
        droppedBefore: null,
      }),
      warn: () => {},
    });
    await writer.observe(inputs());
    now += LIVE_STATUS_EVERY_MS;
    await writer.observe(inputs());
    let read = await readLiveStatus(dir, now);
    expect(read.kind === 'fresh' && read.status.conversations[0]!.since).toBe(
      '2026-10-28T15:00:00.000Z'
    );
    state = 'parked';
    now += LIVE_STATUS_EVERY_MS;
    await writer.observe(inputs());
    read = await readLiveStatus(dir, now);
    expect(read.kind === 'fresh' && read.status.conversations[0]).toMatchObject({
      state: 'parked',
      since: '2026-10-28T15:00:20.000Z',
    });
    if (read.kind !== 'fresh') throw new Error('not fresh');
    const since = eventsSince(read.status, T0 + 1_500);
    expect(since.counts.parked_for_cap).toBe(0);
    expect(since.counts.starts_refused).toBe(4);
    expect(since.refused_by_reason).toEqual({ cap: 4 });
    expect(since.complete).toBe(true);
    const all = eventsSince(read.status, T0);
    expect(all.parks).toEqual([
      {
        at: '2026-10-28T15:00:01.000Z',
        kind: 'parked_for_cap',
        agent: '7b1e5c0a',
        conversation: 'conv-1',
      },
    ]);
    expect(formatEventsSince(all).split('\n')[0]).toContain('parked_for_cap=1');
  });
});

describe('checkedLiveStatusDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-dir-check-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (path: string) => ({ SWITCH_CONTROLLER_LIVE_STATUS_DIR: path });

  it('takes a private folder of this user’s outside the data folder', async () => {
    const live = join(dir, 'live');
    mkdirSync(live, { mode: 0o700 });
    mkdirSync(join(dir, 'data'));
    expect(await checkedLiveStatusDir(env(live), join(dir, 'data'))).toBe(realpathSync(live));
    expect(await checkedLiveStatusDir({}, join(dir, 'data'))).toBeNull();
  });

  it('refuses the data folder, a folder inside it, a missing folder, a file and a shared folder', async () => {
    const data = join(dir, 'data');
    mkdirSync(join(data, 'inside'), { recursive: true, mode: 0o700 });
    chmodSync(data, 0o700);
    await expect(checkedLiveStatusDir(env(data), data)).rejects.toThrow(/data folder/);
    await expect(checkedLiveStatusDir(env(join(data, 'inside')), data)).rejects.toThrow(
      /data folder/
    );
    await expect(checkedLiveStatusDir(env(join(dir, 'nowhere')), data)).rejects.toThrow(
      /does not exist/
    );
    writeFileSync(join(dir, 'a-file'), '');
    await expect(checkedLiveStatusDir(env(join(dir, 'a-file')), data)).rejects.toThrow(
      /not a folder/
    );
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    await expect(checkedLiveStatusDir(env(shared), data)).rejects.toThrow(/others can write/);
    // A link to the data folder is the data folder.
    symlinkSync(data, join(dir, 'link'));
    await expect(checkedLiveStatusDir(env(join(dir, 'link')), data)).rejects.toThrow(/data folder/);
  });
});

describe('a live folder that fails its checks', () => {
  it('turns the live status off with one error, and the controller runs on', async () => {
    const errors: { message: string; fields: unknown }[] = [];
    const dir = await liveStatusDirOrOff(
      { SWITCH_CONTROLLER_LIVE_STATUS_DIR: '/no/such/folder' },
      '/tmp',
      { error: (message, fields) => errors.push({ message, fields }) }
    );
    expect(dir).toBeNull();
    expect(errors).toEqual([
      {
        message: 'The live status is off: its folder is not safe to write to',
        fields: { why: expect.stringContaining('does not exist') },
      },
    ]);
  });
});

describe('conversations that don’t fit', () => {
  it('are left out, and at most 50 an agent are listed, rather than failing the write', () => {
    const many = Array.from({ length: MAX_CONVERSATIONS_PER_AGENT + 5 }, (_, i) => ({
      id: `conv-${i}`,
      agentId: AGENT_A,
      state: 'parked' as const,
    }));
    const status = liveStatusFrom(
      inputs(),
      {
        ...EXTRAS,
        conversations: [{ id: 'has spaces', agentId: AGENT_B, state: 'busy' }, ...many],
      },
      { startedAt: T0, now: T0, peakAwake: 0 }
    );
    expect(status.conversations).toHaveLength(MAX_CONVERSATIONS_PER_AGENT);
    expect(status.conversations.every((c) => c.agent === '7b1e5c0a')).toBe(true);
  });
});

describe('launcher mode (a split box)', () => {
  it('reports process and login-copy counts as null, never as 0', () => {
    const status = liveStatusFrom(inputs({ launcherMode: true }), EXTRAS, {
      startedAt: T0,
      now: T0,
      peakAwake: 0,
    });
    expect(status.controller.launcher_mode).toBe(true);
    expect(status.box.claude_processes).toBeNull();
    expect(status.box.host_processes).toBeNull();
    for (const agent of status.agents) {
      expect(agent.claude_processes).toBeNull();
      expect(agent.host_processes).toBeNull();
      expect(agent.login_copies).toBeNull();
      expect(agent.newest_login_copy_at).toBeNull();
    }
    // The controller's own figures are still its own.
    expect(status.box.memory_bytes).toBe(2 * 1024 ** 3);
    expect(status.controller.anon_bytes).toBe(120 * 1024 ** 2);
  });
});
