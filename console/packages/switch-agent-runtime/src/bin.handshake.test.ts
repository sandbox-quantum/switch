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

/**
 * An ops endpoint that remembers who asked.
 *
 * Which agent the runtime *bound* is only observable in the credentials it then
 * uses: the agent id is in the ops path and the token is in its Authorization
 * header. Asserting on those is what distinguishes "resolved the agent the
 * environment named" from "picked one and carried on".
 */
async function recordingOpsServer(): Promise<{ endpoint: string; calls: () => string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.url} ${req.headers.authorization ?? ''}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ operations: {} }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${port}`, calls: () => calls };
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
 * A throwaway working directory and `HOME` for one spawn.
 *
 * Credential resolution reads `./.switch/agents/`, and the runtime keeps its
 * session state under `$HOME` — so a shared root would let whatever the
 * developer happens to have configured decide whether these tests pass.
 */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'switch-runtime-test-'));
  sandboxes.push(dir);
  return dir;
}

/** Provision an agent in a sandbox, in the shape switchdash writes. */
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
      env: {
        SWITCH_API_ENDPOINT: agent.endpoint,
        SWITCH_AGENT_ID: agent.agentId,
        ...(agent.token === undefined ? {} : { SWITCH_API_TOKEN: agent.token }),
      },
    })
  );
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

  it('completes a token-less environment from the store rather than refusing', async () => {
    // The shape a host settings file produces: it names the agent and leaves the
    // credential on disk. Claude Code exports that block into this process, so
    // treating it as half a config stranded every hand-started session — the
    // exact case the store exists for.
    const { endpoint, calls } = await recordingOpsServer();
    const run = start({ SWITCH_API_ENDPOINT: endpoint, SWITCH_AGENT_ID: 'uuid-solo' }, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    await handshake(run);
    const listed = (await request(run, 2, 'tools/list')) as {
      result?: { tools?: { name: string }[] };
    };

    expect((listed.result?.tools ?? []).map((t) => t.name)).not.toContain('switch_unavailable');
    // The store's token, against the id the environment named — on the ops call
    // and on everything that follows it.
    expect(calls()).toContain('/agents/uuid-solo/ops Bearer tok-solo');
    expect(calls().every((c) => c.startsWith('/agents/uuid-solo/') && c.endsWith('Bearer tok-solo'))).toBe(
      true
    );
  });

  it('binds the agent the environment names, not whichever the store lists first', async () => {
    // With several provisioned, "it worked" is not evidence: the guarantee is
    // that the id in the environment decides, so the wrong pick must be visible.
    const { endpoint, calls } = await recordingOpsServer();
    const run = start({ SWITCH_AGENT_ID: 'uuid-b' }, (root) => {
      provision(root, { slug: 'alice', agentId: 'uuid-a', endpoint, token: 'tok-a' });
      provision(root, { slug: 'bob', agentId: 'uuid-b', endpoint, token: 'tok-b' });
    });

    await handshake(run);

    expect(calls()).toContain('/agents/uuid-b/ops Bearer tok-b');
    expect(calls().some((c) => c.includes('uuid-a') || c.includes('tok-a'))).toBe(false);
  });

  it('refuses when the environment names an agent the store does not hold', async () => {
    // Falling through to a general store search here would bind somebody else,
    // which is the failure the old blanket refusal was right to prevent.
    const endpoint = await opsServer();
    const run = start({ SWITCH_AGENT_ID: 'uuid-env' }, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('uuid-env');
    expect(text).toContain('uuid-solo');
  });

  it('refuses when the named agent belongs to a different server', async () => {
    const endpoint = await opsServer();
    const run = start(
      { SWITCH_API_ENDPOINT: 'https://elsewhere.example', SWITCH_AGENT_ID: 'uuid-solo' },
      (root) => provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('elsewhere.example');
  });

  it('still refuses a token that names no agent', async () => {
    // Unchanged, and for the original reason: every request is addressed to an
    // agent id, and a bare token gives nothing to infer one from.
    const endpoint = await opsServer();
    const run = start({ SWITCH_API_ENDPOINT: endpoint, SWITCH_API_TOKEN: 'tok-env' }, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('agent_id=MISSING');
  });

  it('reports which piece is missing when a token comes without an endpoint', async () => {
    // The diagnostic has to name the variable actually absent. Saying "agent_id
    // is not set" while it plainly is sends the reader after the wrong thing.
    const endpoint = await opsServer();
    const run = start({ SWITCH_API_TOKEN: 'tok-env', SWITCH_AGENT_ID: 'uuid-env' }, (root) =>
      provision(root, { slug: 'solo', agentId: 'uuid-solo', endpoint, token: 'tok-solo' })
    );

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('endpoint=MISSING');
    expect(text).toContain('agent_id=uuid-env');
    expect(text).not.toContain('agent_id=MISSING');
  });

  it('refuses when two store entries claim the same agent id', async () => {
    // Two files, two tokens, nothing saying which is current. Taking the first
    // would leave the session working while the hook — which refuses on this
    // same condition — quietly stops mediating it.
    const endpoint = await opsServer();
    const run = start({ SWITCH_AGENT_ID: 'uuid-dup' }, (root) => {
      provision(root, { slug: 'a-first', agentId: 'uuid-dup', endpoint, token: 'tok-a' });
      provision(root, { slug: 'b-second', agentId: 'uuid-dup', endpoint, token: 'tok-b' });
    });

    const { tools, text } = await degradedAnswer(run);

    expect(tools).toEqual(['switch_unavailable']);
    expect(text).toContain('a-first.json');
    expect(text).toContain('b-second.json');
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
