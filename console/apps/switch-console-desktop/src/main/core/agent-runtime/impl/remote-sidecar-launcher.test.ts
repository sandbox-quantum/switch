import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchSpec } from '../../../../sidecar/agent-launch-spec';
import { SIDECAR_BUNDLE_REL_PATH } from '../../../../sidecar/sidecar-paths';
import { SIDECAR_VERSION } from '../../../../sidecar/sidecar-version';
import {
  agentSidecarTmuxName,
  killSidecarSession,
  reapOrphanedSidecars,
  reapStaleAgentSidecars,
  RemoteSidecarLauncher,
  type SidecarHost,
  type SidecarLaunchConfig,
  writeWatchEnabled,
} from './remote-sidecar-launcher';

const SPEC: AgentLaunchSpec = {
  command: '/usr/bin/claude',
  args: ['--session-id', '__SWITCHDASH_SESSION_ID__', '__SWITCHDASH_INITIAL_PROMPT__'],
  env: { BASE: '1' },
  cwd: '/home/dev/repo',
  providerId: 'claude',
  deeplinkScheme: 'switchdash',
};

const CONFIG: SidecarLaunchConfig = {
  repoDir: '/home/dev/repo',
  deeplinkScheme: 'switchdash',
  launchSpec: SPEC,
  credsSlug: 'claude-code.repo.me',
};

/** The endpoint the launcher derives for CONFIG — sessions are pointed at this
 * path rather than at the port/token, so it must track repoDir + credsSlug. */
const ENDPOINT_FILE = '/home/dev/repo/.switchdash/agents/claude-code.repo.me/endpoint';
const ENDPOINT = { port: 4321, token: 'tok-abc', endpointFile: ENDPOINT_FILE };

const readyLine = (
  hash: string | undefined = 'hash-v1',
  epoch = 1,
  version: string | undefined = SIDECAR_VERSION
): string =>
  `${JSON.stringify({
    event: 'ready',
    port: 4321,
    token: 'tok-abc',
    hash,
    epoch,
    version,
  })}\n`;
const noopLog = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface ExecCall {
  command: string;
  args: string[];
}

function isLaunchSpecWrite(script: string): boolean {
  return script.includes('base64 -d');
}
function isDeployLock(script: string): boolean {
  return script.includes('deploy.lock') && script.includes('mkdir');
}
function isLockRelease(script: string): boolean {
  // The acquire script also contains an `rm -rf` (its stale-break branch), so
  // match only the standalone release.
  return script.startsWith('rm -rf') && script.includes('deploy.lock');
}
function isBundleRename(script: string): boolean {
  return script.startsWith('mv ');
}

function makeHost(
  opts: {
    existingSidecar?: boolean;
    readyAfter?: number;
    diesAfter?: number;
    remoteBundleHash?: string;
    /** Simulates another client holding the host-side deploy lock. */
    lockHeld?: boolean;
    /** Version the running sidecar reports (undefined = predates the field). */
    readyVersion?: string;
    /** Sessions recorded in the running sidecar's durable state. */
    liveSessions?: number;
    /** Bundle hash the (already-running) sidecar's ready line reports. */
    readyHash?: string;
    /** What `tail` of the sidecar log returns after a startup crash. */
    logTail?: string;
  } = {}
): { host: SidecarHost; calls: ExecCall[]; puts: Array<{ local: string; remote: string }> } {
  const existingSidecar = opts.existingSidecar ?? false;
  const readyHash = opts.readyHash ?? 'hash-v1';
  const readyVersion = 'readyVersion' in opts ? opts.readyVersion : SIDECAR_VERSION;
  const readyAfter = opts.readyAfter ?? 0;
  const diesAfter = opts.diesAfter ?? Infinity;
  const calls: ExecCall[] = [];
  const puts: Array<{ local: string; remote: string }> = [];
  let sidecarExists = existingSidecar;
  let catReads = 0;
  let aliveChecks = 0;
  // The real sidecar bumps its epoch on every start; the launcher relies on
  // that to tell a freshly-launched process from the one it just killed.
  let epoch = 1;

  const host: SidecarHost = {
    async exec(command, args) {
      calls.push({ command, args });
      if (command === 'sh') {
        const script = args[1] ?? '';
        if (isDeployLock(script)) {
          // `mkdir` succeeds unless another client holds the lock.
          return { stdout: opts.lockHeld ? 'busy' : 'acquired', stderr: '' };
        }
        if (isLaunchSpecWrite(script) || isLockRelease(script) || isBundleRename(script)) {
          return { stdout: '', stderr: '' };
        }
        // prepareDir: `sha256sum <bundle>` output is "<hash>  <path>".
        const remote = opts.remoteBundleHash;
        return { stdout: remote ? `${remote}  ${SIDECAR_BUNDLE_REL_PATH}` : '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'new-session') {
        sidecarExists = true;
        epoch += 1;
        return { stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'kill-session') {
        sidecarExists = false;
        return { stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        aliveChecks++;
        if (aliveChecks > diesAfter) sidecarExists = false;
        if (!sidecarExists) throw new Error('no session');
        return { stdout: '', stderr: '' };
      }
      if (command === 'cat') {
        // The launcher reads two different files through `cat`.
        if ((args[0] ?? '').endsWith('state.json')) {
          const sessions = Array.from({ length: opts.liveSessions ?? 0 }, (_, i) => ({
            sessionId: `s${i}`,
          }));
          return { stdout: JSON.stringify({ version: '1', epoch, sessions }), stderr: '' };
        }
        const line = readyLine(readyHash, epoch, readyVersion);
        if (existingSidecar) return { stdout: line, stderr: '' };
        const n = catReads++;
        if (n < readyAfter) throw new Error('no such file');
        return { stdout: line, stderr: '' };
      }
      if (command === 'tail') {
        return { stdout: opts.logTail ?? '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    async putFile(local, remote) {
      puts.push({ local, remote });
    },
  };
  return { host, calls, puts };
}

function makeLauncher(host: SidecarHost) {
  return new RemoteSidecarLauncher({
    host,
    bundlePath: '/local/dist-sidecar/sidecar.mjs',
    sidecarTmuxName: 'switchdash-sidecar-abc',
    config: CONFIG,
    log: noopLog,
    sleep: async () => {},
    hashBundle: async () => 'hash-v1',
  });
}

describe('RemoteSidecarLauncher', () => {
  it('writes the launch spec, deploys the bundle, and returns the ready endpoint', async () => {
    const { host, calls, puts } = makeHost();
    const endpoint = await makeLauncher(host).deployAndLaunch();

    expect(endpoint).toEqual(ENDPOINT);
    // The bundle lands on a temp path and is renamed into place: an SFTP
    // overwrite of the live file is observable half-written, and node loading
    // it mid-transfer dies on a SyntaxError.
    expect(puts).toHaveLength(1);
    expect(puts[0]!.local).toBe('/local/dist-sidecar/sidecar.mjs');
    // A uuid, not a pid: the bundle is shared per directory while the deploy
    // lock is per agent, so two clients on different machines can upload
    // concurrently and a pid is not unique across them.
    expect(puts[0]!.remote).toMatch(/^\.switchdash\/sidecar\.mjs\.[0-9a-f-]{36}\.tmp$/);
    const rename = calls.find((c) => c.command === 'sh' && isBundleRename(c.args[1] ?? ''));
    expect(rename!.args[1]).toContain(`mv '${puts[0]!.remote}' '.switchdash/sidecar.mjs'`);
    const specWrite = calls.find((c) => c.command === 'sh' && isLaunchSpecWrite(c.args[1] ?? ''));
    // Per-agent state path (keyed by the creds slug), not the shared per-dir path.
    expect(specWrite!.args[1]).toContain(
      '.switchdash/agents/claude-code.repo.me/agent-launch-spec.json'
    );
    // Atomic: write to a per-process temp then mv into place, so nothing observes
    // a torn, unparseable spec file.
    expect(specWrite!.args[1]).toMatch(/> "\$tmp".*&& mv "\$tmp"/);
  });

  it('skips the bundle upload when the host already holds an identical bundle', async () => {
    const { host, puts } = makeHost({ remoteBundleHash: 'hash-v1' });
    const endpoint = await makeLauncher(host).deployAndLaunch();
    expect(endpoint).toEqual(ENDPOINT);
    expect(puts).toHaveLength(0);
  });

  it('launches the sidecar detached with the agent-scoped env', async () => {
    const { host, calls } = makeHost();
    await makeLauncher(host).deployAndLaunch();

    const launch = calls.find((c) => c.command === 'tmux' && c.args[0] === 'new-session');
    expect(launch!.args.slice(0, 6)).toEqual([
      'new-session',
      '-d',
      '-s',
      'switchdash-sidecar-abc',
      '-c',
      '/home/dev/repo',
    ]);
    const inner = launch!.args[6];
    expect(inner).toContain("SWITCHDASH_SIDECAR_REPO_DIR='/home/dev/repo'");
    expect(inner).toContain("SWITCHDASH_SIDECAR_AGENT_SLUG='claude-code.repo.me'");
    expect(inner).not.toContain('SWITCHDASH_SIDECAR_LOCATION_ID');
    expect(inner).not.toContain('SWITCHDASH_SIDECAR_TMUX_TARGET');
    expect(inner).toContain('.switchdash/sidecar.mjs');
  });

  it('polls the ready file until the sidecar reports its endpoint', async () => {
    const { host } = makeHost({ readyAfter: 3 });
    expect(await makeLauncher(host).deployAndLaunch()).toEqual(ENDPOINT);
  });

  it('fails loud if the sidecar tmux session dies during startup', async () => {
    const { host } = makeHost({ readyAfter: 5, diesAfter: 1 });
    await expect(makeLauncher(host).deployAndLaunch()).rejects.toThrow(/exited during startup/);
  });

  it('surfaces the sidecar log tail so the real crash is visible', async () => {
    const { host } = makeHost({
      readyAfter: 5,
      diesAfter: 1,
      logTail: "SyntaxError: Unexpected token '.'",
    });
    await expect(makeLauncher(host).deployAndLaunch()).rejects.toThrow(
      /exited during startup — last output.*SyntaxError: Unexpected token/s
    );
  });

  it('reattaches to a running sidecar without redeploying, but still rewrites the spec', async () => {
    const { host, calls, puts } = makeHost({ existingSidecar: true });
    const endpoint = await makeLauncher(host).deployAndLaunch();

    expect(endpoint).toEqual(ENDPOINT);
    expect(puts).toHaveLength(0);
    expect(calls.find((c) => c.command === 'tmux' && c.args[0] === 'new-session')).toBeUndefined();
    expect(
      calls.find((c) => c.command === 'sh' && isLaunchSpecWrite(c.args[1] ?? ''))
    ).toBeDefined();
  });

  it('does not delete the ready file, so a healthy sidecar stays discoverable', async () => {
    // Clearing it up front made a running sidecar invisible to every other
    // client for the length of the deploy — and permanently if the deploy died.
    const { host, calls } = makeHost();
    await makeLauncher(host).deployAndLaunch();

    const removedReady = calls.some(
      (c) =>
        c.command === 'sh' &&
        (c.args[1] ?? '').includes('rm -f') &&
        (c.args[1] ?? '').includes('sidecar.ready')
    );
    expect(removedReady).toBe(false);
  });

  it('takes the deploy lock before replacing the sidecar, and releases it after', async () => {
    const { host, calls } = makeHost();
    await makeLauncher(host).deployAndLaunch();

    const lockIdx = calls.findIndex((c) => c.command === 'sh' && isDeployLock(c.args[1] ?? ''));
    const killIdx = calls.findIndex((c) => c.command === 'tmux' && c.args[0] === 'kill-session');
    const releaseIdx = calls.findIndex((c) => c.command === 'sh' && isLockRelease(c.args[1] ?? ''));

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(killIdx);
    expect(releaseIdx).toBeGreaterThan(killIdx);
  });

  it('refuses to replace the sidecar while another client holds the deploy lock', async () => {
    // Better to fail loudly than to race a concurrent deploy: both clients
    // would overwrite the bundle under each other and kill each other's process.
    const { host, calls } = makeHost({ lockHeld: true });

    await expect(makeLauncher(host).deployAndLaunch()).rejects.toThrow(/another client/i);
    expect(calls.some((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBe(false);
  });

  it('releases the deploy lock even when the launch fails', async () => {
    const { host, calls } = makeHost({ diesAfter: 1 });

    await expect(makeLauncher(host).deployAndLaunch()).rejects.toThrow();
    expect(calls.some((c) => c.command === 'sh' && isLockRelease(c.args[1] ?? ''))).toBe(true);
  });

  it('hashes the deployed bundle on the host instead of trusting a sidecar hash file', async () => {
    const { host, calls, puts } = makeHost({ remoteBundleHash: 'hash-v1' });
    await makeLauncher(host).deployAndLaunch();

    expect(calls.some((c) => c.command === 'sh' && (c.args[1] ?? '').includes('sha256sum'))).toBe(
      true
    );
    // Identical bundle already on the host — no re-upload.
    expect(puts).toHaveLength(0);
  });

  it('relaunches a running sidecar whose bundle hash is stale (upgrade takes effect)', async () => {
    // A sidecar left over from an older bundle reports a different hash in its
    // ready line — it must be killed and relaunched, not reattached to, or the
    // new bundle (e.g. one that adds the /sessions endpoint) never comes online.
    const { host, calls, puts } = makeHost({ existingSidecar: true, readyHash: 'hash-OLD' });
    const endpoint = await makeLauncher(host).deployAndLaunch();

    expect(endpoint).toEqual(ENDPOINT);
    expect(puts).toHaveLength(1); // new bundle uploaded
    expect(calls.find((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBeDefined();
    expect(calls.find((c) => c.command === 'tmux' && c.args[0] === 'new-session')).toBeDefined();
  });

  it('passes the bundle hash to the launched sidecar so it can echo it on ready', async () => {
    const { host, calls } = makeHost();
    await makeLauncher(host).deployAndLaunch();
    const launch = calls.find((c) => c.command === 'tmux' && c.args[0] === 'new-session');
    expect(launch!.args[6]).toContain("SWITCHDASH_SIDECAR_BUNDLE_HASH='hash-v1'");
  });

  it('stop() kills the sidecar tmux session', async () => {
    const { host, calls } = makeHost();
    await makeLauncher(host).stop();
    expect(calls).toContainEqual({
      command: 'tmux',
      args: ['kill-session', '-t', '=switchdash-sidecar-abc'],
    });
  });
});

describe('RemoteSidecarLauncher versioning', () => {
  it('probes a running sidecar of a DIFFERENT build — a build difference is not an incompatibility', async () => {
    // The two-client kill-loop: each client judged the other's sidecar unusable
    // purely because its bundle hash differed, killed it, relaunched, and
    // reported zero sessions in between — pruning live rows on both sides.
    const { host, calls } = makeHost({ existingSidecar: true, readyHash: 'hash-other' });

    const endpoint = await makeLauncher(host).probeExisting();

    expect(endpoint).toEqual(ENDPOINT);
    expect(calls.some((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBe(false);
  });

  it('refuses to probe a sidecar speaking a protocol it cannot support', async () => {
    const { host } = makeHost({
      existingSidecar: true,
      readyVersion: '2.0',
    });

    expect(await makeLauncher(host).probeExisting()).toBeNull();
  });

  it('treats a sidecar predating the version field as major 0, still usable', async () => {
    const { host } = makeHost({ existingSidecar: true, readyVersion: undefined });

    expect(await makeLauncher(host).probeExisting()).toEqual(ENDPOINT);
  });

  it('defers an available upgrade while the sidecar has live sessions', async () => {
    const { host, calls } = makeHost({
      existingSidecar: true,
      readyHash: 'hash-old',
      liveSessions: 2,
    });

    const endpoint = await makeLauncher(host).deployAndLaunch();

    expect(endpoint).toEqual(ENDPOINT);
    expect(calls.some((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBe(false);
  });

  it('takes the upgrade once the sidecar is idle', async () => {
    const { host, calls } = makeHost({
      existingSidecar: true,
      readyHash: 'hash-old',
      liveSessions: 0,
    });

    await makeLauncher(host).deployAndLaunch();

    expect(calls.some((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBe(true);
  });

  it('replaces an incompatible sidecar even when sessions are live', async () => {
    // Compatibility is the one reason worth interrupting work for: we cannot
    // talk to it at all, so deferring would mean never recovering.
    const { host, calls } = makeHost({
      existingSidecar: true,
      readyVersion: '2.0',
      liveSessions: 3,
    });

    await makeLauncher(host).deployAndLaunch();

    expect(calls.some((c) => c.command === 'tmux' && c.args[0] === 'kill-session')).toBe(true);
  });
});

describe('agentSidecarTmuxName', () => {
  it('is deterministic per repo dir + slug and does not end in -sidecar', () => {
    const a = agentSidecarTmuxName('/home/dev/repo', 'agent-a');
    expect(a).toBe(agentSidecarTmuxName('/home/dev/repo', 'agent-a'));
    expect(a).not.toBe(agentSidecarTmuxName('/home/dev/other', 'agent-a'));
    // Two agents sharing one repo dir get distinct sidecars (CHOO-1440).
    expect(a).not.toBe(agentSidecarTmuxName('/home/dev/repo', 'agent-b'));
    expect(a.endsWith('-sidecar')).toBe(false);
  });
});

describe('writeWatchEnabled', () => {
  it('writes 1 / 0 to the agent-scoped watch-enabled flag file', async () => {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      putFile: async () => {},
    };
    await writeWatchEnabled(host, 'agent-a', true);
    await writeWatchEnabled(host, 'agent-a', false);
    expect(calls[0].args[1]).toContain('printf %s 1 > ');
    expect(calls[0].args[1]).toContain('.switchdash/agents/agent-a/watch-enabled');
    expect(calls[1].args[1]).toContain('printf %s 0 > ');
  });
});

describe('killSidecarSession', () => {
  it('kills the named session and swallows a missing one', async () => {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      putFile: async () => {},
    };
    await killSidecarSession(host, 'switchdash-sidecar-abc', noopLog);
    expect(calls).toContainEqual({
      command: 'tmux',
      args: ['kill-session', '-t', '=switchdash-sidecar-abc'],
    });
  });
});

describe('reapStaleAgentSidecars', () => {
  const REPO = '/home/dev/repo';
  /** What a pre-CHOO-1440 client named this agent's sidecar: hash(repoDir) alone. */
  const legacyName = `switchdash-sidecar-${createHash('sha256').update(REPO).digest('hex').slice(0, 16)}`;
  const current = agentSidecarTmuxName(REPO, 'agent-a');
  const sibling = agentSidecarTmuxName(REPO, 'agent-b');
  const renamedFrom = agentSidecarTmuxName(REPO, 'agent-a-old');
  const otherDir = agentSidecarTmuxName('/home/dev/other', 'agent-z');

  function reaperHost(sessions: Array<[name: string, path: string]>) {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      async exec(command, args) {
        calls.push({ command, args });
        if (command === 'tmux' && args[0] === 'list-sessions') {
          return { stdout: sessions.map(([n, p]) => `${n}\t${p}`).join('\n'), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      async putFile() {},
    };
    const kills = (): string[] =>
      calls
        .filter((c) => c.command === 'tmux' && c.args[0] === 'kill-session')
        .map((c) => c.args[2]!);
    return { host, kills };
  }

  it('kills leftover generations in the dir, sparing siblings and other dirs', async () => {
    const { host, kills } = reaperHost([
      [current, REPO],
      [legacyName, REPO], // pre-CHOO-1440 naming — same agent, unreachable name
      [renamedFrom, REPO], // the name this agent ran under before it was renamed
      [sibling, REPO], // a co-located agent's own sidecar
      [otherDir, '/home/dev/other'], // an agent this client knows nothing about
      ['switchdash-abc123', REPO], // an agent pane, not a sidecar
    ]);

    await reapStaleAgentSidecars(host, REPO, [current, sibling], noopLog);

    expect(kills()).toEqual([`=${legacyName}`, `=${renamedFrom}`]);
  });

  it('kills nothing when every sidecar in the dir is claimed', async () => {
    const { host, kills } = reaperHost([
      [current, REPO],
      [sibling, REPO],
    ]);
    await reapStaleAgentSidecars(host, REPO, [current, sibling], noopLog);
    expect(kills()).toEqual([]);
  });

  it('refuses to reap when no expected name is supplied', async () => {
    const { host, kills } = reaperHost([[current, REPO]]);
    await reapStaleAgentSidecars(host, REPO, [], noopLog);
    expect(kills()).toEqual([]);
  });

  it('is a no-op when the host has no tmux server', async () => {
    const host: SidecarHost = {
      async exec() {
        throw new Error('no server running');
      },
      async putFile() {},
    };
    await expect(reapStaleAgentSidecars(host, REPO, [current], noopLog)).resolves.toBeUndefined();
  });

  it('keeps reaping after one kill fails', async () => {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      async exec(command, args) {
        calls.push({ command, args });
        if (command === 'tmux' && args[0] === 'list-sessions') {
          return { stdout: `${legacyName}\t${REPO}\n${renamedFrom}\t${REPO}`, stderr: '' };
        }
        if (args[2] === `=${legacyName}`) throw new Error('kill failed');
        return { stdout: '', stderr: '' };
      },
      async putFile() {},
    };
    await reapStaleAgentSidecars(host, REPO, [current], noopLog);
    expect(calls.filter((c) => c.args[0] === 'kill-session').map((c) => c.args[2])).toEqual([
      `=${legacyName}`,
      `=${renamedFrom}`,
    ]);
  });
});

describe('reapOrphanedSidecars', () => {
  function reaperHost(sessions: string[], aliveAgents: string[]) {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      async exec(command, args) {
        calls.push({ command, args });
        if (command === 'tmux' && args[0] === 'list-sessions') {
          return { stdout: sessions.join('\n'), stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'has-session') {
          const target = args[2]!.replace(/^=/, '');
          if (!aliveAgents.includes(target)) throw new Error('no session');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      async putFile() {},
    };
    return { host, calls };
  }

  it('kills sidecars whose agent pane is gone, leaving in-use ones', async () => {
    const { host, calls } = reaperHost(
      ['switchdash-a', 'switchdash-a-sidecar', 'switchdash-b-sidecar', 'other'],
      ['switchdash-a']
    );
    await reapOrphanedSidecars(host, noopLog);

    const kills = calls
      .filter((c) => c.command === 'tmux' && c.args[0] === 'kill-session')
      .map((c) => c.args[2]);
    expect(kills).toEqual(['=switchdash-b-sidecar']);
  });
});
