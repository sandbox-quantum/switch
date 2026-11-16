import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { connectParent, SessionLinks, type ParentChannel } from './session-channel';
import { startSessionMcp } from './session-mcp';

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

/**
 * A session host's end of the pipe joined to its parent's end, as spawning a
 * host with an IPC channel joins them: what one sends, the other receives.
 */
function pipe(links: SessionLinks, root: string): ParentChannel {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message: unknown, callback: (error: Error | null) => void) => {
      setImmediate(() => port.emit('message', message));
      callback(null);
      return true;
    },
  });
  const port = Object.assign(new EventEmitter(), {
    connected: true,
    send: (message: unknown) => {
      setImmediate(() => child.emit('message', message));
      return true;
    },
  });
  links.attach(root, child as unknown as ChildProcess);
  return connectParent(port);
}

/** One JSON-RPC call to a streamable-HTTP MCP server, answered as JSON. */
async function rpc(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ status: number; body: { result?: Record<string, unknown> } | null }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return {
    status: response.status,
    body: response.ok ? ((await response.json()) as { result?: Record<string, unknown> }) : null,
  };
}

const tokenOf = (headers: Record<string, string> | undefined) =>
  headers!.Authorization!.slice('Bearer '.length);

it('serves each session its own server, and forwards every call up its own pipe', async () => {
  const links = new SessionLinks();
  const answered = vi.fn(async (caller: { sessionId: string }, ask: { type: string }) =>
    ask.type === 'tools'
      ? [{ name: `tool-of-${caller.sessionId}`, description: '', inputSchema: { type: 'object' } }]
      : { content: [{ type: 'text', text: `answered for ${caller.sessionId}` }] }
  );
  links.answer('agent', answered);

  const sessions = await Promise.all(
    ['one', 'two', 'three'].map(async (sessionId) => {
      const parent = pipe(links, `/roots/${sessionId}`);
      parent.identify({ agentId: 'agent', sessionId, hostId: `host-${sessionId}`, epoch: 'e' });
      const mcp = await startSessionMcp(parent);
      closing.push(mcp.close);
      return { sessionId, ...mcp.spec, token: tokenOf(mcp.spec.headers) };
    })
  );

  expect(new Set(sessions.map((session) => new URL(session.url).port)).size).toBe(3);
  expect(new Set(sessions.map((session) => session.token)).size).toBe(3);
  for (const session of sessions) {
    expect(new URL(session.url).hostname).toBe('127.0.0.1');
    const listed = await rpc(session.url, session.token, 'tools/list');
    expect(listed.body?.result?.tools).toEqual([
      { name: `tool-of-${session.sessionId}`, description: '', inputSchema: { type: 'object' } },
    ]);
    const called = await rpc(session.url, session.token, 'tools/call', {
      name: 'post_message',
      arguments: { body: 'hi' },
    });
    expect(called.body?.result?.content).toEqual([
      { type: 'text', text: `answered for ${session.sessionId}` },
    ]);
  }
  expect(answered).toHaveBeenCalledWith(
    { agentId: 'agent', sessionId: 'two', hostId: 'host-two', epoch: 'e', root: '/roots/two' },
    { type: 'tool', name: 'post_message', arguments: { body: 'hi' } }
  );

  // One session's token opens nobody else's server.
  expect((await rpc(sessions[0]!.url, sessions[1]!.token, 'tools/list')).status).toBe(401);
  expect((await rpc(sessions[0]!.url, 'x'.repeat(64), 'tools/list')).status).toBe(401);
});

it('answers a call its parent could not make as an error the agent can read', async () => {
  const links = new SessionLinks();
  const parent = pipe(links, '/roots/alone');
  parent.identify({ agentId: 'nobody-watches', sessionId: 's', hostId: 'h', epoch: 'e' });
  const mcp = await startSessionMcp(parent);
  closing.push(mcp.close);
  const called = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'post_message',
    arguments: {},
  });
  expect(called.body?.result?.isError).toBe(true);
  expect(JSON.stringify(called.body?.result?.content)).toContain('No room watcher is running');
});
