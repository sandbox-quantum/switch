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

it('compacts secondary Switch operations when compactTools is enabled over the threshold', async () => {
  const coreNames = [
    'connect_to_room',
    'post_message',
    'send_targeted_message',
    'read_context',
    'get_my_context',
    'download_attachment',
    'send_attachment',
    'list_rooms',
    'list_all_rooms',
    'get_room_detail',
    'list_participants',
    'list_agents',
    'get_agent_detail',
    'create_agent',
    'list_managed_agents',
    'list_machines',
    'list_bridges',
    'run_template',
    'create_room',
    'update_room',
    'list_roles',
    'get_role_detail',
    'assume_role',
    'release_role',
    'list_references',
    'load_internal_documents',
    'list_templates',
  ];
  const secondaryNames = [
    'archive_room',
    'unarchive_room',
    'invite_agent_to_room',
    'remove_agent_from_room',
    'add_users_to_room',
    'link_rooms',
    'unlink_rooms',
    'list_linked_rooms',
    'create_room_from_yaml',
    'create_room_group',
    'list_room_groups',
    'get_room_group_detail',
    'update_agent_detail',
    'request_agent_deletion',
    'set_agent_service',
    'remove_agent_service',
    'get_advanced_config',
    'define_role',
    'edit_role',
    'delete_role',
    'list_all_references',
    'list_reference_types',
    'create_reference',
    'attach_reference_to_room',
    'create_room_document',
    'update_room_document',
    'delete_room_document',
    'list_room_schedules',
    'create_room_schedule',
    'update_room_schedule',
    'pause_room_schedule',
    'delete_room_schedule',
    'get_template',
    'get_template_guide',
    'get_template_status',
    'save_template',
    'update_template',
    'delete_template',
  ];
  const rawTools = [...coreNames, ...secondaryNames].map((name) => ({
    name,
    description: `${name} summary.`,
    inputSchema: {
      type: 'object',
      required: name === 'archive_room' ? ['room_id'] : [],
      properties: name === 'archive_room' ? { room_id: { type: 'string' } } : {},
    },
  }));
  const links = new SessionLinks();
  const answered = vi.fn(async (_caller: { sessionId: string }, ask: Record<string, unknown>) =>
    ask.type === 'tools'
      ? rawTools
      : { content: [{ type: 'text', text: `ran ${ask.name}:${JSON.stringify(ask.arguments)}` }] }
  );
  links.answer('agent', answered);
  const parent = pipe(links, '/roots/compact');
  parent.identify({ agentId: 'agent', sessionId: 's', hostId: 'h', epoch: 'e' });
  const mcp = await startSessionMcp(parent, { compactTools: true });
  closing.push(mcp.close);

  const listed = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/list');
  const listedTools = listed.body?.result?.tools as Array<{ name: string; description: string }>;
  expect(listedTools).toHaveLength(33);
  for (const name of coreNames) {
    expect(listedTools.some((tool) => tool.name === name)).toBe(true);
  }
  const manageRooms = listedTools.find((tool) => tool.name === 'manage_rooms');
  expect(manageRooms?.description).toContain('- archive_room(room_id*): archive_room summary.');

  // Direct core call passes through untouched.
  const direct = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'post_message',
    arguments: { body: 'hello' },
  });
  expect(direct.body?.result?.content).toEqual([
    { type: 'text', text: 'ran post_message:{"body":"hello"}' },
  ]);

  // Grouped call unwraps back to the real Switch operation name.
  const dispatched = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'manage_rooms',
    arguments: { action: 'archive_room', arguments: { room_id: 'r1' } },
  });
  expect(dispatched.body?.result?.content).toEqual([
    { type: 'text', text: 'ran archive_room:{"room_id":"r1"}' },
  ]);

  // `describe: true` returns the underlying schema locally without calling the parent.
  const callCountBeforeDescribe = answered.mock.calls.length;
  const described = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'manage_rooms',
    arguments: { action: 'archive_room', describe: true },
  });
  expect(answered.mock.calls.length).toBe(callCountBeforeDescribe);
  const describedText = (
    described.body?.result?.content as Array<{ text: string }> | undefined
  )?.[0]?.text;
  expect(JSON.parse(describedText!)).toMatchObject({
    name: 'archive_room',
    inputSchema: { required: ['room_id'] },
  });

  // Invalid actions and invalid `arguments` return readable tool errors.
  const badAction = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'manage_roles',
    arguments: { action: 'archive_room' },
  });
  expect(badAction.body?.result?.isError).toBe(true);
  const badArgs = await rpc(mcp.spec.url, tokenOf(mcp.spec.headers), 'tools/call', {
    name: 'manage_rooms',
    arguments: { action: 'archive_room', arguments: 'oops' },
  });
  expect(badArgs.body?.result?.isError).toBe(true);
});
