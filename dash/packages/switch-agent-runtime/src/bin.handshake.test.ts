import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The server's behaviour up to `initialize`, exercised as a real subprocess.
 *
 * A host that spawns this over stdio sees one symptom for every startup
 * failure — the connection closing before the handshake — and does not show
 * the child's stderr, so "no credentials", "endpoint unreachable" and "server
 * is broken" are indistinguishable from outside. The distinction is only
 * visible here, which is why these cases assert on the *manner* of failure
 * (exits, promptly, saying why) and not merely that it failed.
 *
 * `bin.ts` reads its config at module scope and exits from it, so it cannot be
 * imported: the only honest test spawns the built artifact.
 */

const PKG_ROOT = join(import.meta.dirname, '..');
const BIN = join(PKG_ROOT, 'dist', 'bin.mjs');

/** Well under Codex's own budget: a startup failure must resolve far sooner. */
const DEADLINE_MS = 20_000;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'handshake-test', version: '0' },
  },
};

type Running = {
  child: ChildProcess;
  root: string;
  stdout: () => string;
  stderr: () => string;
};

const running: ChildProcess[] = [];
const servers: http.Server[] = [];
const sandboxes: string[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A just-killed child may still hold a file open; the OS reclaims tmp.
    }
  }
});

/** An endpoint serving the operation list the runtime loads before serving. */
async function opsServer(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ operations: {} }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** An endpoint that accepts the connection and then never answers. */
async function blackHoleServer(): Promise<string> {
  const server = http.createServer(() => {
    // Deliberately no response: the runtime must give up on its own.
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/**
 * A throwaway `HOME` and working directory for one spawn.
 *
 * Credential resolution reads `./.switch/agents/` and `~/.switch/agents/`, so
 * the runner's own `HOME` would let whatever the developer happens to have
 * configured decide whether these tests pass — and on a machine with a real
 * agent provisioned, the no-credentials case would find one. Both roots are
 * therefore empty and per-spawn.
 */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'switch-runtime-test-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * Provision an agent in a sandbox: an entry naming it, and a secret keyed by its
 * agent id. Both land in the same directory here only because a sandbox is its
 * own HOME as well as its own working directory — that the two roots are read
 * separately is what the `credentials` unit tests cover.
 */
function provision(
  root: string,
  agent: { slug: string; name?: string; agentId: string; endpoint: string; token?: string }
): void {
  const dir = join(root, '.switch', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agent.slug}.json`),
    JSON.stringify({
      name: agent.name ?? agent.slug,
      agent_id: agent.agentId,
      endpoint: agent.endpoint,
    })
  );
  if (agent.token !== undefined) {
    writeFileSync(join(dir, `${agent.agentId}.json`), JSON.stringify({ token: agent.token }), {
      mode: 0o600,
    });
  }
}

function start(env: Record<string, string>, setup?: (root: string) => void): Running {
  const root = sandbox();
  setup?.(root);
  const child = spawn(process.execPath, [BIN], {
    cwd: root,
    // A fixed environment, as a host gives it: nothing leaks in from this runner.
    env: { PATH: process.env.PATH ?? '', HOME: root, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);

  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr.on('data', (c: Buffer) => {
    err += c.toString();
  });
  return { child, root, stdout: () => out, stderr: () => err };
}

/** Resolve with the JSON-RPC response carrying `id`. */
function responseWithin(run: Running, id: number, ms: number): Promise<Record<string, unknown>> {
  const seek = (): Record<string, unknown> | null => {
    for (const line of run.stdout().split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id === id) return message as Record<string, unknown>;
      } catch {
        // Partial line; wait for the rest.
      }
    }
    return null;
  };

  return new Promise((resolve, reject) => {
    // The answer may already be buffered from an earlier read, in which case no
    // further 'data' event is coming and waiting for one would hang.
    const already = seek();
    if (already) return resolve(already);

    const timer = setTimeout(() => reject(new Error(`no response to ${id} within ${ms}ms`)), ms);
    run.child.stdout!.on('data', () => {
      const found = seek();
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    });
  });
}

/** Complete `initialize` and the follow-up notification, leaving the server live. */
async function handshake(run: Running): Promise<void> {
  run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);
  await responseWithin(run, 1, DEADLINE_MS);
  run.child.stdin!.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
  );
}

/** Send one request and resolve with its response. */
async function request(
  run: Running,
  id: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  run.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return responseWithin(run, id, DEADLINE_MS);
}

/**
 * Complete the handshake and return the single degraded tool plus what it says.
 *
 * Asserting on stderr alone would prove nothing here: the point of degraded mode
 * is that the reason reaches the SESSION, over the protocol, rather than to a
 * log nobody opens.
 */
async function degradedAnswer(run: Running): Promise<{ tools: string[]; text: string }> {
  await handshake(run);
  const listed = (await request(run, 2, 'tools/list')) as {
    result?: { tools?: { name: string }[] };
  };
  const called = (await request(run, 3, 'tools/call', {
    name: 'switch_unavailable',
    arguments: {},
  })) as { result?: { content?: { text?: string }[] } };
  return {
    tools: (listed.result?.tools ?? []).map((t) => t.name),
    text: called.result?.content?.[0]?.text ?? '',
  };
}

describe.skipIf(!existsSync(BIN))('the Switch runtime as a host spawns it', () => {
  it('answers initialize when its credentials are present', async () => {
    const endpoint = await opsServer();
    const run = start({
      SWITCH_API_ENDPOINT: endpoint,
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'agent-1',
    });
    run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

    const response = (await responseWithin(run, 1, DEADLINE_MS)) as {
      result?: { protocolVersion?: string; serverInfo?: { name?: string } };
    };

    expect(response.result?.protocolVersion).toBeTruthy();
    expect(response.result?.serverInfo?.name).toBeTruthy();
  });

  it('serves the reason, rather than exiting, when nothing configures it at all', async () => {
    // Exiting made this the quietest failure available: the host shows a closed
    // connection and the session is told nothing. Starting anyway with one tool
    // is what puts the reason where someone will read it.
    const { tools, text } = await degradedAnswer(start({}));

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('.switch/agents');
    expect(text).toContain('configure');
  });

  it('publishes no port while degraded, so a pre-expansion spawn cannot race', async () => {
    // The `${SWITCH_*}` spawn used to exit on sight for exactly this reason.
    // Now nothing exits, so the guard is that degraded mode writes no port file
    // — it starts no hook listener to advertise.
    const run = start({});
    await degradedAnswer(run);

    const sessions = join(run.root, '.switch', 'sessions');
    const ports = existsSync(sessions)
      ? readdirSync(sessions).filter((d) => existsSync(join(sessions, d, 'port')))
      : [];
    expect(ports).toEqual([]);

    // The directory itself is expected: the diagnostic is also written to
    // `startup-error.log` there, for an operator who does go looking.
    expect(
      readdirSync(sessions).some((d) => existsSync(join(sessions, d, 'startup-error.log')))
    ).toBe(true);
  });

  it('starts from the local store when the host forwarded nothing', async () => {
    const endpoint = await opsServer();
    const run = start({}, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );
    run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

    const response = (await responseWithin(run, 1, DEADLINE_MS)) as {
      result?: { protocolVersion?: string };
    };

    expect(response.result?.protocolVersion).toBeTruthy();
    expect(run.stderr()).toContain('agent_id=uuid-solo');
  });

  it('treats an unexpanded ${SWITCH_*} as absent and falls through to the store', async () => {
    // Claude spawns the server once before expanding its settings env block.
    // Literals must not be mistaken for credentials, nor suppress the store.
    const endpoint = await opsServer();
    const run = start(
      {
        SWITCH_API_ENDPOINT: '${SWITCH_API_ENDPOINT}',
        SWITCH_API_TOKEN: '${SWITCH_API_TOKEN}',
        SWITCH_AGENT_ID: '${SWITCH_AGENT_ID}',
      },
      (root) => provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );
    run.child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);

    const response = (await responseWithin(run, 1, DEADLINE_MS)) as {
      result?: { protocolVersion?: string };
    };

    expect(response.result?.protocolVersion).toBeTruthy();
    expect(run.stderr()).toContain('agent_id=uuid-solo');
  });

  it('refuses to guess which server it belongs to when the store spans two', async () => {
    const run = start({}, (root) => {
      provision(root, {
        slug: 'dev',
        agentId: 'uuid-dev',
        endpoint: 'https://dev.example',
        token: 't1',
      });
      provision(root, {
        slug: 'prod',
        agentId: 'uuid-prod',
        endpoint: 'https://prod.example',
        token: 't2',
      });
    });

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('span 2 Switch servers');
    // The fix has to travel with the diagnosis, or the agent can only relay
    // that something is broken.
    expect(text).toContain('SWITCH_API_ENDPOINT');
    expect(text).toContain('dev.example');
    expect(text).toContain('prod.example');
  });

  it('offers select_agent, and refuses everything else, until an identity is bound', async () => {
    const endpoint = await opsServer();
    const run = start({}, (root) => {
      provision(root, { slug: 'alice', agentId: 'uuid-a', endpoint, token: 'tok-a' });
      provision(root, { slug: 'bob', agentId: 'uuid-b', endpoint, token: 'tok-b' });
    });

    await handshake(run);

    const listed = (await request(run, 2, 'tools/list')) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('select_agent');

    const refused = (await request(run, 3, 'tools/call', {
      name: 'download_attachment',
      arguments: { mxc: 'mxc://example/1' },
    })) as { result?: { isError?: boolean; content?: { text?: string }[] } };

    expect(refused.result?.isError).toBe(true);
    const text = refused.result?.content?.[0]?.text ?? '';
    expect(text).toContain('select_agent');
    expect(text).toContain('alice');
    expect(text).toContain('bob');
  });

  it('binds the chosen agent when select_agent names one', async () => {
    const endpoint = await opsServer();
    const run = start({}, (root) => {
      provision(root, { slug: 'alice', agentId: 'uuid-a', endpoint, token: 'tok-a' });
      provision(root, { slug: 'bob', agentId: 'uuid-b', endpoint, token: 'tok-b' });
    });

    await handshake(run);

    const bound = (await request(run, 2, 'tools/call', {
      name: 'select_agent',
      arguments: { name: 'bob' },
    })) as { result?: { isError?: boolean; structuredContent?: { agent_id?: string } } };

    expect(bound.result?.isError).toBeFalsy();
    expect(bound.result?.structuredContent?.agent_id).toBe('uuid-b');
    expect(run.stderr()).toContain('bound to bob');
  });

  it('names the agents it knows when select_agent names one it does not', async () => {
    const endpoint = await opsServer();
    const run = start({}, (root) => {
      provision(root, { slug: 'alice', agentId: 'uuid-a', endpoint, token: 'tok-a' });
      provision(root, { slug: 'bob', agentId: 'uuid-b', endpoint, token: 'tok-b' });
    });

    await handshake(run);

    const answer = (await request(run, 2, 'tools/call', {
      name: 'select_agent',
      arguments: { name: 'carol' },
    })) as { result?: { isError?: boolean; content?: { text?: string }[] } };

    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain('alice');
  });

  it('does not fall back to the store on half an identity, and says so', async () => {
    // Being the wrong agent is worse than being no agent: a partial environment
    // is a broken config, and quietly using the store instead would hide it.
    const endpoint = await opsServer();
    const run = start({ SWITCH_AGENT_ID: 'uuid-env' }, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('incomplete SWITCH_* environment');
  });

  it(
    'answers, rather than hanging, when Switch never replies',
    async () => {
      // Credentials were fine; the server was not. Indistinguishable from "no
      // credentials" if the process just dies, which is why this degrades too.
      const endpoint = await blackHoleServer();
      const run = start({
        SWITCH_API_ENDPOINT: endpoint,
        SWITCH_API_TOKEN: 'tok-123',
        SWITCH_AGENT_ID: 'agent-1',
      });

      const { tools, text } = await degradedAnswer(run);

      expect(tools).toEqual(['switch_unavailable']);
      expect(text).toContain(endpoint);
    },
    // Must outlast the runtime's own fetch bound, which is the thing under test.
    DEADLINE_MS + 15_000
  );

  it('names the endpoint it could not reach, not just that it failed', async () => {
    const run = start({
      SWITCH_API_ENDPOINT: 'http://127.0.0.1:1',
      SWITCH_API_TOKEN: 'tok-123',
      SWITCH_AGENT_ID: 'agent-1',
    });

    const { text } = await degradedAnswer(run);

    expect(text).toMatch(/cannot reach Switch at http:\/\/127\.0\.0\.1:1/);
  });

  it('answers any tool name while degraded, not just its own', async () => {
    // A host that cached a fuller list from an earlier session will call one of
    // those; "Unknown tool" would tell the session nothing.
    const run = start({});
    await handshake(run);

    const called = (await request(run, 2, 'tools/call', {
      name: 'list_rooms',
      arguments: {},
    })) as { result?: { isError?: boolean; content?: { text?: string }[] } };

    expect(called.result?.isError).toBe(true);
    expect(called.result?.content?.[0]?.text).toContain('Switch is unavailable');
  });
});
