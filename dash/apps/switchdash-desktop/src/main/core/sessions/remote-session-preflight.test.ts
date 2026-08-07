import { describe, expect, it, vi } from 'vitest';
import { preflightRemoteSession } from './remote-session-preflight';

const log = { warn: vi.fn() };

const CREDS_FILE = JSON.stringify({
  env: {
    SWITCH_API_ENDPOINT: 'https://switch.example.com',
    SWITCH_API_TOKEN: 'tok',
    SWITCH_AGENT_ID: 'agent-1',
  },
});

function makeDeps(opts: {
  missingBinaries?: string[];
  nodeVersion?: string;
  credsFile?: string | null;
  endpointReachable?: boolean;
  workDirMissing?: boolean;
  channelExhausted?: boolean;
}) {
  const missing = opts.missingBinaries ?? [];
  const nodeVersion = opts.nodeVersion ?? 'v18.19.0';
  const exec = vi.fn(async (command: string, _args: string[]) => {
    // Combined working-dir + required-tools probe (`sh -c <script>`). A missing
    // dir or exhausted channel rejects; otherwise missing tools and node's
    // version land on stdout as `missing <tool>` / `node <version>` lines.
    if (command === 'sh') {
      if (opts.channelExhausted) {
        throw Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 });
      }
      if (opts.workDirMissing) throw new Error('cd: no such file or directory');
      const lines = [
        ...missing.map((b) => `missing ${b}`),
        ...(missing.includes('node') ? [] : [`node ${nodeVersion}`]),
      ];
      return { stdout: lines.join('\n'), stderr: '' };
    }
    if (command === 'node') {
      if (opts.endpointReachable === false) throw new Error('ECONNREFUSED');
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  const fs = {
    read: vi.fn(async (_path: string) => {
      if (opts.credsFile == null) throw new Error('no such file');
      return { content: opts.credsFile };
    }),
  };
  return {
    ctx: { exec },
    fs,
    log,
    host: 'box',
    workDir: '/home/agent/repo',
    credsRelPaths: ['.switch/agents/agent-1.json', '.claude/settings.local.json'],
    exec,
  };
}

describe('preflightRemoteSession', () => {
  it('passes when tools, creds, and endpoint are all good', async () => {
    const deps = makeDeps({ credsFile: CREDS_FILE, endpointReachable: true });
    await expect(preflightRemoteSession(deps)).resolves.toBeUndefined();
    // Reachability is probed against the endpoint from the creds file.
    expect(deps.exec).toHaveBeenCalledWith('node', [
      '-e',
      expect.any(String),
      'https://switch.example.com',
    ]);
  });

  it('fails loud with a clear message when the working directory is missing', async () => {
    const deps = makeDeps({ workDirMissing: true, credsFile: CREDS_FILE });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(
      /remote working directory '\/home\/agent\/repo' on host 'box' is not usable/
    );
    // A rejected probe must not be misreported as missing tools, and the
    // endpoint reachability check must not run once the host is known unusable.
    expect(deps.exec).not.toHaveBeenCalledWith('node', expect.anything());
  });

  it('blames the SSH connection, not the working dir, when channels are exhausted', async () => {
    const deps = makeDeps({ channelExhausted: true, credsFile: CREDS_FILE });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(
      /could not open another channel.*MaxSessions/s
    );
    // It must not be misreported as a missing/unusable working directory.
    await expect(preflightRemoteSession(deps)).rejects.not.toThrow(/working directory/);
  });

  it('fails loud listing every missing binary', async () => {
    const deps = makeDeps({ missingBinaries: ['tmux', 'git'], credsFile: CREDS_FILE });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(/missing required tools: tmux, git/);
  });

  it('fails loud when node is present but too old', async () => {
    const deps = makeDeps({ nodeVersion: 'v12.22.9', credsFile: CREDS_FILE });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(
      /has Node v12.22.9, but the switchdash sidecar needs Node 18 or newer/
    );
  });

  it('fails loud when the remote creds file is absent', async () => {
    const deps = makeDeps({ credsFile: null });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(/no Switch credentials/);
  });

  it('reads the neutral per-agent creds path in preference to the legacy one', async () => {
    const deps = makeDeps({ endpointReachable: true });
    // Neutral path has creds; the legacy path is absent — the preflight should
    // still pass by reading the neutral file first (CHOO-1440).
    deps.fs.read = vi.fn(async (path: string) => {
      if (path === '.switch/agents/agent-1.json') return { content: CREDS_FILE };
      throw new Error('no such file');
    });
    await expect(preflightRemoteSession(deps)).resolves.toBeUndefined();
    expect(deps.fs.read).toHaveBeenCalledWith('.switch/agents/agent-1.json');
  });

  it('falls back to the legacy settings.local.json when the neutral file is absent', async () => {
    const deps = makeDeps({ endpointReachable: true });
    deps.fs.read = vi.fn(async (path: string) => {
      if (path === '.claude/settings.local.json') return { content: CREDS_FILE };
      throw new Error('no such file');
    });
    await expect(preflightRemoteSession(deps)).resolves.toBeUndefined();
  });

  it('fails loud when the creds file is incomplete', async () => {
    const deps = makeDeps({ credsFile: JSON.stringify({ env: { SWITCH_AGENT_ID: 'a' } }) });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(/incomplete/);
  });

  it('fails loud when the host cannot reach the Switch endpoint', async () => {
    const deps = makeDeps({ credsFile: CREDS_FILE, endpointReachable: false });
    await expect(preflightRemoteSession(deps)).rejects.toThrow(/cannot reach the Switch endpoint/);
  });
});
