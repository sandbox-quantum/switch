/**
 * A Switch server that knows one room.
 *
 * It answers the two routes the session's tools reach, `GET /agents/{id}/ops`
 * and `POST /agents/{id}/ops/{name}`, so everything between the model and
 * this server is the shipped code: the catalog, the call, the loopback MCP
 * server. The catalog is the real one (`scripts/dump_operations.py`); the
 * answers are the scenario's room, shaped as the real operations shape them.
 * What the agent posts is recorded, and also joins the room's timeline, so a
 * later `read_context` sees it.
 *
 * An operation the room has no answer for is refused with a message saying
 * so, and recorded, so a run that leaned on one shows it.
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { Scenario } from './scenario';

export type ToolCall = { name: string; args: Record<string, unknown>; refused: boolean };
export type Post = {
  tool: 'post_message' | 'send_targeted_message';
  body: string;
  targets: string[];
  threadId: string | null;
};

type Entry = {
  id: string;
  kind: 'message';
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  attachments: never[];
};

export type FakeSwitch = {
  endpoint: string;
  agentId: string;
  roomId: string;
  messageId: string;
  calls: ToolCall[];
  posts: Post[];
  close: () => Promise<void>;
};

const id = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
const userId = (name: string) => `@switch-slack-${name}:switch.local`;

export async function startFakeSwitch(
  scenario: Scenario,
  operations: Record<string, unknown>
): Promise<FakeSwitch> {
  const agentId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const agentUser = `@switch-agent-${agentId.slice(0, 8)}:switch.local`;
  const now = Date.now();
  const timeline: Entry[] = scenario.history.map((message) => ({
    id: id('sw_'),
    kind: 'message',
    sender: userId(message.sender),
    sender_name: message.sender,
    body: message.body,
    timestamp: now - message.minutesAgo * 60_000,
    attachments: [],
  }));
  const addressed: Entry = {
    id: id('sw_'),
    kind: 'message',
    sender: userId(scenario.message.sender),
    sender_name: scenario.message.sender,
    body: `@${scenario.agentName} ${scenario.message.body}`,
    timestamp: now,
    attachments: [],
  };
  timeline.push(addressed);

  const calls: ToolCall[] = [];
  const posts: Post[] = [];
  const participants = [
    ...scenario.room.participants.map((p, index) => ({
      id: `${index}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
      name: p.name,
      type: p.type,
      agent_type: p.type === 'agent' ? 'auto_session' : null,
      can_delegate: p.type === 'agent',
      can_accept: p.type === 'agent',
      status: p.type === 'agent' ? 'live' : null,
      room_role: null,
      alias: null,
    })),
    {
      id: agentId,
      name: scenario.agentName,
      type: 'agent',
      agent_type: 'auto_session',
      can_delegate: true,
      can_accept: true,
      status: 'live',
      room_role: null,
      alias: null,
    },
  ];
  const resources = { references: [], documents: [], packages: [] };

  const post = (tool: Post['tool'], args: Record<string, unknown>) => {
    const targets = [
      ...((args.target_names as string[] | undefined) ?? []),
      ...((args.target_roles as string[] | undefined) ?? []),
    ];
    const body = String(args.body ?? '');
    posts.push({ tool, body, targets, threadId: (args.thread_id as string | undefined) ?? null });
    const entry: Entry = {
      id: id('sw_'),
      kind: 'message',
      sender: agentUser,
      sender_name: scenario.agentName,
      body: targets.map((t) => `@${t} `).join('') + body,
      timestamp: Date.now(),
      attachments: [],
    };
    timeline.push(entry);
    return entry.id;
  };

  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_rooms: () => [
      {
        room_id: roomId,
        name: scenario.room.name,
        description: scenario.room.description,
        connected: true,
        archived: false,
      },
    ],
    connect_to_room: () => ({
      agent_id: agentId,
      room_id: roomId,
      name: scenario.room.name,
      description: scenario.room.description,
      participants,
      instructions: scenario.room.instructions
        ? `## Room-specific instructions\n\n${scenario.room.instructions.trim()}`
        : '',
      reference_types: {},
      ...resources,
      linked_rooms: [],
      roles: [],
      warning: null,
    }),
    read_context: (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const since = typeof args.since === 'string' ? Date.parse(args.since) : NaN;
      const entries = timeline
        .filter((e) => Number.isNaN(since) || e.timestamp >= since)
        .slice(-limit);
      return {
        threads: entries.map((root) => ({ root, replies: [] })),
        truncated: false,
        oldest_timestamp: entries[0]?.timestamp ?? null,
      };
    },
    list_participants: () => participants,
    get_room_detail: () => ({
      id: roomId,
      name: scenario.room.name,
      description: scenario.room.description,
      bridge_display_name: scenario.room.platform,
      channel_type: 'channel_public',
      members: participants,
      roles: [],
      aliases: {},
    }),
    list_references: () => resources,
    list_roles: () => [],
    list_linked_rooms: () => [],
    post_message: (args) => ({ event_id: post('post_message', args) }),
    send_targeted_message: (args) => ({
      event_id: post('send_targeted_message', args),
      target_statuses: {},
    }),
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && path === `/agents/${agentId}/ops`) {
      reply(200, { operations });
      return;
    }
    const match = /^\/agents\/[^/]+\/ops\/([^/]+)$/.exec(path);
    if (req.method !== 'POST' || !match) {
      reply(404, { detail: 'not found' });
      return;
    }
    const name = match[1]!;
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const args = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const answer = answers[name];
      calls.push({ name, args, refused: !answer });
      if (!answer) {
        reply(400, { detail: `${name} is not available in this test environment.` });
        return;
      }
      try {
        reply(200, { result: answer(args) });
      } catch (error) {
        reply(400, { detail: String(error) });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    agentId,
    roomId,
    messageId: addressed.id,
    calls,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
