import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchSpec } from '../../../../sidecar/agent-launch-spec';
import {
  agentSidecarTmuxName,
  killSidecarSession,
  reapOrphanedSidecars,
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
  projectId: 'proj-1',
  repoDir: '/home/dev/repo',
  deeplinkScheme: 'switchdash',
  launchSpec: SPEC,
};

const readyLine = (hash: string | undefined = 'hash-v1'): string =>
  `${JSON.stringify({ event: 'ready', port: 4321, token: 'tok-abc', hash })}\n`;
const noopLog = { debug: vi.fn(), warn: vi.fn() };

interface ExecCall {
  command: string;
  args: string[];
}

function isLaunchSpecWrite(script: string): boolean {
  return script.includes('base64 -d');
}
function isBundleHashWrite(script: string): boolean {
  return script.includes('printf %s') && script.includes('.sha256');
}

function makeHost(
  opts: {
    existingSidecar?: boolean;
    readyAfter?: number;
    diesAfter?: number;
    remoteBundleHash?: string;
    /** Bundle hash the (already-running) sidecar's ready line reports. */
    readyHash?: string;
    /** What `tail` of the sidecar log returns after a startup crash. */
    logTail?: string;
  } = {}
): { host: SidecarHost; calls: ExecCall[]; puts: Array<{ local: string; remote: string }> } {
  const existingSidecar = opts.existingSidecar ?? false;
  const readyLineOut = readyLine(opts.readyHash ?? 'hash-v1');
  const readyAfter = opts.readyAfter ?? 0;
  const diesAfter = opts.diesAfter ?? Infinity;
  const calls: ExecCall[] = [];
  const puts: Array<{ local: string; remote: string }> = [];
  let sidecarExists = existingSidecar;
  let catReads = 0;
  let aliveChecks = 0;

  const host: SidecarHost = {
    async exec(command, args) {
      calls.push({ command, args });
      if (command === 'sh') {
        const script = args[1] ?? '';
        if (isLaunchSpecWrite(script) || isBundleHashWrite(script))
          return { stdout: '', stderr: '' };
        return { stdout: opts.remoteBundleHash ?? '', stderr: '' }; // prepareDir hash read
      }
      if (command === 'tmux' && args[0] === 'new-session') {
        sidecarExists = true;
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
        if (existingSidecar) return { stdout: readyLineOut, stderr: '' };
        const n = catReads++;
        if (n < readyAfter) throw new Error('no such file');
        return { stdout: readyLineOut, stderr: '' };
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

    expect(endpoint).toEqual({ port: 4321, token: 'tok-abc' });
    expect(puts).toEqual([
      { local: '/local/dist-sidecar/sidecar.mjs', remote: '.switchdash/sidecar.mjs' },
    ]);
    const specWrite = calls.find((c) => c.command === 'sh' && isLaunchSpecWrite(c.args[1] ?? ''));
    expect(specWrite!.args[1]).toContain('.switchdash/agent-launch-spec.json');
    // Atomic: write to a per-process temp then mv into place, so agents sharing a
    // repo dir can't interleave writes and leave a torn, unparseable spec file.
    expect(specWrite!.args[1]).toMatch(/> "\$tmp".*&& mv "\$tmp"/);
  });

  it('skips the bundle upload when the host already holds an identical bundle', async () => {
    const { host, puts } = makeHost({ remoteBundleHash: 'hash-v1' });
    const endpoint = await makeLauncher(host).deployAndLaunch();
    expect(endpoint).toEqual({ port: 4321, token: 'tok-abc' });
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
    expect(inner).toContain("SWITCHDASH_SIDECAR_PROJECT_ID='proj-1'");
    expect(inner).not.toContain('SWITCHDASH_SIDECAR_CONVERSATION_ID');
    expect(inner).not.toContain('SWITCHDASH_SIDECAR_TMUX_TARGET');
    expect(inner).toContain('.switchdash/sidecar.mjs');
  });

  it('polls the ready file until the sidecar reports its endpoint', async () => {
    const { host } = makeHost({ readyAfter: 3 });
    expect(await makeLauncher(host).deployAndLaunch()).toEqual({ port: 4321, token: 'tok-abc' });
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

    expect(endpoint).toEqual({ port: 4321, token: 'tok-abc' });
    expect(puts).toHaveLength(0);
    expect(calls.find((c) => c.command === 'tmux' && c.args[0] === 'new-session')).toBeUndefined();
    expect(
      calls.find((c) => c.command === 'sh' && isLaunchSpecWrite(c.args[1] ?? ''))
    ).toBeDefined();
  });

  it('relaunches a running sidecar whose bundle hash is stale (upgrade takes effect)', async () => {
    // A sidecar left over from an older bundle reports a different hash in its
    // ready line — it must be killed and relaunched, not reattached to, or the
    // new bundle (e.g. one that adds the /sessions endpoint) never comes online.
    const { host, calls, puts } = makeHost({ existingSidecar: true, readyHash: 'hash-OLD' });
    const endpoint = await makeLauncher(host).deployAndLaunch();

    expect(endpoint).toEqual({ port: 4321, token: 'tok-abc' });
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

describe('agentSidecarTmuxName', () => {
  it('is deterministic per repo dir and does not end in -sidecar', () => {
    const a = agentSidecarTmuxName('/home/dev/repo');
    expect(a).toBe(agentSidecarTmuxName('/home/dev/repo'));
    expect(a).not.toBe(agentSidecarTmuxName('/home/dev/other'));
    expect(a.endsWith('-sidecar')).toBe(false);
  });
});

describe('writeWatchEnabled', () => {
  it('writes 1 / 0 to the watch-enabled flag file', async () => {
    const calls: ExecCall[] = [];
    const host: SidecarHost = {
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '' };
      },
      putFile: async () => {},
    };
    await writeWatchEnabled(host, true);
    await writeWatchEnabled(host, false);
    expect(calls[0].args[1]).toContain('printf %s 1 > ');
    expect(calls[0].args[1]).toContain('.switchdash/watch-enabled');
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
