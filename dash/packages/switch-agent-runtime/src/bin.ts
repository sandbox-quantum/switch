#!/usr/bin/env node
/**
 * The Switch agent runtime: one stdio MCP server, shared by every host.
 *
 * It serves the Switch tool surface — fetched from the server at startup rather
 * than hardcoded, so it cannot drift — and turns each call into
 * `POST /agents/{id}/ops/{tool}` on a connection to the Agent Bridge. That
 * connection is a server-sent event stream, which is also how addressed
 * messages and task events arrive; unless notifications are suppressed they are
 * surfaced to the session.
 *
 * The room comes from `connect_to_room`, which claims it on this process's
 * connection — or, when a supervisor handed one over in `SWITCH_CONNECTION_ID`,
 * on the supervisor's. Either way the room is known here without observing
 * anything.
 *
 * A localhost hook port remains for the one case that misses: a Claude Code
 * session nobody supervised, whose `PostToolUse` hook POSTs the room id here.
 * The port is advertised at `~/.switch/sessions/${ppid}/port`, where ppid is
 * this process's parent PID (the host session). The hook resolves the same path
 * from its own getppid(), so each session's hook reaches its own runtime
 * without any cross-session coordination.
 *
 * Config comes from `SWITCH_*` env vars: the Claude connector sets them in its
 * `.mcp.json` env block, the Codex profile in `env_vars`, and switchdash puts
 * them in the session's environment when it launches one itself.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readSse, type SseFrame } from './sse';

const API_ENDPOINT = process.env.SWITCH_API_ENDPOINT ?? '';
const API_TOKEN = process.env.SWITCH_API_TOKEN ?? '';
const AGENT_ID = process.env.SWITCH_AGENT_ID ?? '';

// When this session is managed by switchdash, switchdash reads the agent
// bridge itself and injects addressed messages into the PTY. Reads are no
// longer destructive, so both can read the same events without stealing from
// each other — but the agent would be told twice. So we still hold the
// connection (it is what correlates every tool call and proves this session is
// reachable) and simply do not surface events as notifications.
// Env var name kept for compatibility with switchdash releases in the wild.
const SUPPRESS_NOTIFICATIONS = process.env.SWITCH_CHANNEL_DISABLE_POLL === '1';

// Claude Code may spawn this server twice on startup: once before settings.env
// expansion (vars literal as `${SWITCH_*}`) and once with real values. Reject
// the unresolved spawn so it doesn't race the real one for the port file.
function looksUnresolved(value: string): boolean {
  return value.startsWith('${') && value.endsWith('}');
}

const SESSION_PPID = process.ppid;
const SESSION_DIR = path.join(os.homedir(), '.switch', 'sessions', String(SESSION_PPID));
const PORT_FILE = path.join(SESSION_DIR, 'port');
const STARTUP_ERROR_FILE = path.join(SESSION_DIR, 'startup-error.log');

/** True once the transport is serving; before that, any failure is fatal. */
let serving = false;

/**
 * Refuse to start, saying why in the two places someone can find it.
 *
 * A host reports a server that dies before the handshake as nothing more than a
 * closed connection, and does not surface the child's stderr — so every cause
 * looks identical from the outside. The file is what makes them tell apart.
 */
function failStartup(reason: string): never {
  process.stderr.write(`switch: ${reason}\n`);
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(STARTUP_ERROR_FILE, `${new Date().toISOString()} ${reason}\n`);
  } catch {
    // Best effort: stderr already carries the reason.
  }
  process.exit(1);
}

if (
  !API_ENDPOINT ||
  !API_TOKEN ||
  !AGENT_ID ||
  looksUnresolved(API_ENDPOINT) ||
  looksUnresolved(API_TOKEN) ||
  looksUnresolved(AGENT_ID)
) {
  failStartup(
    `missing or unresolved config — need SWITCH_API_ENDPOINT, SWITCH_API_TOKEN, and SWITCH_AGENT_ID\n` +
      `  endpoint=${API_ENDPOINT || 'MISSING'}\n` +
      `  token=${API_TOKEN ? 'set' : 'MISSING'}\n` +
      `  agent_id=${AGENT_ID || 'MISSING'}\n` +
      `If these look like \`\${SWITCH_*}\`, the env block in \`.claude/settings.local.json\` has not been expanded — run the \`configure\` skill.\n` +
      `If they are simply absent, the host did not pass them through: Codex forwards only the names listed in \`env_vars\` on its \`mcp_servers\` entry.`
  );
}

process.stderr.write(`switch: ppid=${SESSION_PPID} session_dir=${SESSION_DIR}\n`);

// Before the transport is serving these must be fatal. A listener that only
// logs takes Node's own fatal-error path away, so a rejected top-level await
// leaves the process to drain its event loop and exit having answered nothing
// — the least debuggable shape this failure can take.
process.on('unhandledRejection', (err) => {
  if (!serving) failStartup(`unhandled rejection during startup: ${err}`);
  process.stderr.write(`switch: unhandled rejection: ${err}\n`);
});
process.on('uncaughtException', (err) => {
  if (!serving) failStartup(`uncaught exception during startup: ${err}`);
  process.stderr.write(`switch: uncaught exception: ${err}\n`);
});

// -- Types matching core/switch_core/bridges/agent/events.py ----------------------

type AttachmentRef = {
  filename: string;
  mimetype: string;
  size: number;
  mxc: string;
  msgtype: string;
};

type MessagePayload = {
  addressed: boolean;
  sender: string;
  sender_name: string;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id?: string | null;
  attachments?: AttachmentRef[];
};

type CommandPayload = {
  command: string;
  target: string | null;
  user_id: string;
  user_name: string;
};

type RoomJoinPayload = {
  member: string;
  member_name: string;
  timestamp: number;
  listening: boolean;
};

type TaskDelegatePayload = {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
  summary: string;
  description: string;
};

type TaskAcceptPayload = {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
};

type TaskUpdatePayload = {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
  update: string;
};

type TaskFinalisePayload = {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
  outcome: string | null;
};

type TaskCancelPayload = {
  task_id: string;
  requester_agent_id: string;
  performer_agent_id: string;
  reason: string | null;
};

type AgentEvent = {
  type: string;
  room_id: string;
  bridge_id: string | null;
  channel_type: string | null;
  payload:
    | MessagePayload
    | CommandPayload
    | RoomJoinPayload
    | TaskDelegatePayload
    | TaskAcceptPayload
    | TaskUpdatePayload
    | TaskFinalisePayload
    | TaskCancelPayload;
};

// -- Connection state --------------------------------------------------------
//
// The client picks its own connection id and reuses it when reconnecting, so a
// dropped stream reattaches to the same server-side connection instead of
// creating a new one. That is what lets a brief network drop cost a gap in
// delivery rather than this session's room slot.

// A supervisor that spawned this session may hand it a connection to share
// (switchdash does: it opens the stream, then passes the id in the
// environment). Then this process holds no stream and no heartbeat of its own —
// it only tags its tool calls with the id, so the server can tell which session
// is calling and which room that session is in.
//
// The point is that `connect_to_room` then claims the room on the *supervisor's*
// connection, which is the one delivering events. Two connections for one
// session is what made the supervisor unable to see its own agent's room, and
// left it scraping tool responses to find out.
//
// Absent the hand-off — a bare terminal session, or one the supervisor merely
// attached to — this process owns its connection exactly as before.
//
// It is read from the ambient environment and NOT declared in the plugin's
// .mcp.json. Host env vars reach a spawned MCP server anyway, and declaring it
// there made it mandatory: a `${VAR}` in that block that resolves to nothing
// fails the whole server with "Missing environment variables", so every session
// without a supervisor — the standalone case — lost its tools entirely.
function borrowedConnectionId(): string | null {
  const raw = process.env.SWITCH_CONNECTION_ID?.trim();
  if (!raw) return null;
  // An unexpanded `${...}` means someone declared this in a config file and the
  // host did not substitute it. Using it as an id would tag every tool call
  // with a connection that cannot exist, which the server rejects — and the
  // reason would be invisible from here. Ignore it and own the connection.
  if (raw.includes('${')) {
    process.stderr.write(
      `switch: ignoring unexpanded SWITCH_CONNECTION_ID (${raw}) — opening our own connection\n`
    );
    return null;
  }
  return raw;
}

const BORROWED_CONNECTION_ID = borrowedConnectionId();
const CONNECTION_ID = BORROWED_CONNECTION_ID ?? randomUUID();
const OWNS_CONNECTION = BORROWED_CONNECTION_ID === null;

let pollingRoomId: string | null = null;
let streamAbort: AbortController | null = null;
let leaseAbort: AbortController | null = null;
let heartbeatAbort: AbortController | null = null;

// Highest sequence number processed. Sent back on reconnect (as Last-Event-ID)
// to resume exactly where we stopped, and on every heartbeat so the server can
// trim what we have seen.
let cursor = 0;

// Whether the currently open stream declared a room when it opened.
let streamHasRoom = false;

// Unaddressed room messages are filtered out (never surfaced as a
// notification), so the agent silently falls behind on room chatter. We tally
// how many we've dropped since the agent last read context and surface that
// count on every notification we DO emit, so the agent knows when to call
// read_context to catch up. Reset to 0 when the agent reads context (signalled
// by the /read-context hook) and when polling switches rooms.
let missedSinceRead = 0;

// Reason from the most recent `gap` frame, held until it can ride out on a
// notification the agent was going to receive anyway.
//
// A gap says events were dropped and cannot be replayed. That must never be
// silent, but it does not warrant a wake of its own: the only available
// response is to re-read context, and the agent cannot know whether anything
// it cared about was in the hole. Waking for it spends a turn on a maybe.
// Deferring costs nothing — the warning still arrives before the agent's next
// reply, which is the point at which stale context would actually mislead it.
let pendingGapReason: string | null = null;

// -- MCP server --------------------------------------------------------------

const mcp = new Server(
  { name: 'switch', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'Events from Switch rooms arrive as <channel source="plugin:switch-connector:switch" room_id="..." event_type="..." ...>.',
      'Only addressed messages, room_join events, and task events are delivered — unaddressed room chatter is filtered out.',
      '',
      'A room_join event fires when a user or agent joins a room — but you are only notified for rooms where you are configured to receive join events (per-room, per-agent; off by default, set via the join_event_listeners option on create_room / update_room or the gateway). The meta carries member (their matrix id) and member_name (their display name). React if it is relevant — e.g. a welcome agent greets the new arrival and explains the room via post_message, or send_targeted_message to address them directly. Your own join does not produce a room_join event.',
      '',
      'Every notification carries a `missed_count` in its meta: the number of unaddressed room messages filtered out since you last called read_context. When it is above 0 the one-line body is annotated with it. A growing count means the room is active around you and you have fallen behind — call read_context (widen `since` to cover the gap) to catch up on what you missed. The count resets to 0 when you call read_context.',
      '',
      'Delivery is automatic: when you call connect_to_room on the switch MCP server, a PostToolUse hook pushes the room id to this channel over a localhost port. The channel claims that room on its connection and events are pushed to you as they happen. No separate tool call is needed.',
      '',
      'If a notification carries a gap warning (a `gap` entry in its meta, and a line saying earlier events were dropped), some room events could not be replayed — call read_context before responding rather than assuming you have the full picture. A gap never arrives as a notification of its own; it is attached to the next event you receive.',
      '',
      'When you receive a message event:',
      '1. Call read_context with the since parameter set to a timestamp a few minutes before the event timestamp to get recent conversation context without re-reading the full history.',
      '2. Understand what is being asked or discussed.',
      '3. Respond by calling post_message (or send_targeted_message if addressing a specific agent).',
      '',
      'If a message event has an image_path attribute, the sender attached one or more images. Each path is a local file already downloaded for you (comma-separated if several) — Read it to see the image before responding.',
      'If it has a file_path attribute, the sender attached one or more non-image files (.md, .csv, .pdf, logs, code — comma-separated if several), already downloaded for you. Read them before responding.',
      'A failed_attachments attribute lists files the sender attached that could NOT be retrieved. Do not pretend you saw them — say so.',
      '',
      "To view a file that appears in read_context history but did NOT arrive with an image_path/file_path (e.g. an unaddressed file posted earlier), call the download_attachment tool with the attachment's mxc (from the read_context attachments field). It writes the file locally and returns the path — then Read that path.",
      'To send files into the room, call the send_attachment tool with `path` (one file) or `paths` (several, delivered as ONE message) plus an optional caption/thread_id. Any file type works. They post as native room attachments and bridged platforms (Slack, Mattermost) receive them as real file uploads.',
      '',
      'When you receive a task_delegate event (only delivered if your integration profile has can_accept=true):',
      '1. Call accept_task with the task_id to move it to ongoing.',
      '2. Call read_context with since to understand the conversation context.',
      '3. Perform the work described in the task. Optionally call update_task(task_id, update) with progress messages as you work — these are persisted.',
      '4. Call finalise_task(task_id, outcome) with a one-string description of what happened (success or failure).',
      '',
      'When you receive task_accept, task_update, or task_finalise events for tasks you delegated, review the progress/outcome and continue your work accordingly.',
      'When you receive a task_cancel event, the task is dead — do not finalise it.',
      '',
      'You must be connected to the room (via connect_to_room) before calling read_context, post_message, send_targeted_message, or any task tool.',
    ].join('\n'),
  }
);

// Addressed images are auto-downloaded and surfaced as image_path on the
// notification. This tool lets the agent fetch ANY attachment on demand — e.g.
// an image seen in read_context history that arrived unaddressed (no
// notification, so no image_path). It writes the bytes to a local file and
// returns the path, which the agent then Reads.
const DOWNLOAD_ATTACHMENT_TOOL = {
  name: 'download_attachment',
  description:
    'Download a room attachment (by its mxc:// URI, as returned in an ' +
    "attachment's `mxc` field from read_context) to a local file and return " +
    'the path. Works for any file type. Use this to view a file from history ' +
    'that did not arrive with an image_path/file_path. Operates on the ' +
    'currently connected room unless ' +
    'room_id is given.',
  inputSchema: {
    type: 'object',
    properties: {
      mxc: {
        type: 'string',
        description: "The attachment's mxc:// URI (from a read_context attachment).",
      },
      filename: {
        type: 'string',
        description: 'Optional original filename, used to name the local file.',
      },
      room_id: {
        type: 'string',
        description: 'Optional Switch room id. Defaults to the currently polling room.',
      },
    },
    required: ['mxc'],
  },
};

// The outbound counterpart of download_attachment: the agent names a local
// file (e.g. a screenshot it produced) and this runtime uploads the bytes to
// the agent bridge, which posts them into the room as an m.image / m.file
// event — from there the collaboration bridges relay it out to Slack /
// Mattermost like any other room message.
const SEND_ATTACHMENT_TOOL = {
  name: 'send_attachment',
  description:
    'Send one or more local files of ANY type (image, .md, .csv, .pdf, log, ' +
    'code) into the connected Switch room as attachments. They enter the room ' +
    'as native image/file events and bridged platforms (Slack, Mattermost) ' +
    'receive them as real file uploads. Several files sent in one call arrive ' +
    'as ONE message carrying all of them. Pass `path` for a single file or ' +
    '`paths` for several. Oversize or unreadable files fail the whole call — ' +
    'nothing is sent silently. Operates on the currently connected room unless ' +
    'room_id is given.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the local file to send.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Absolute paths of several local files to send as one message. ' +
          'Use instead of `path` for a multi-attachment message.',
      },
      caption: {
        type: 'string',
        description: 'Optional text to accompany the attachment.',
      },
      thread_id: {
        type: 'string',
        description:
          'Optional message id to reply into, making this a threaded reply ' +
          '(normalised to the thread root).',
      },
      room_id: {
        type: 'string',
        description: 'Optional Switch room id. Defaults to the currently polling room.',
      },
    },
  },
};

// -- Switch operations, served locally --------------------------------------
//
// The agent's whole tool surface is served from this process. Each tool is one
// of Switch's operations, fetched from the server at startup so the two cannot
// drift, and each call becomes POST /ops/{name} on THIS process's connection.
//
// That last part is the point: because the stream and the tool surface live in
// the same process, a tool call is correlated to a connection structurally —
// the connection id never has to travel through the agent or its config, and
// cannot be forgotten, leaked, or attached to the wrong session.

type SwitchOperation = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

let operations: SwitchOperation[] = [];

/**
 * How long to wait for the operation list before giving up.
 *
 * Unbounded, an unreachable endpoint holds the handshake open until the host's
 * own startup timeout fires, which reports a timeout and names no cause. A
 * bounded wait fails first and says what it was waiting for.
 */
const OPERATIONS_FETCH_TIMEOUT_MS = 15_000;

async function loadOperations(): Promise<void> {
  const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/ops`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(OPERATIONS_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    // Without the operation list this process cannot serve the agent at all.
    // Fail loudly at startup rather than presenting an empty tool surface that
    // looks like "Switch has nothing to offer".
    throw new Error(`cannot load Switch operations: HTTP ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    operations: Record<string, { description: string; input_schema: Record<string, unknown> }>;
  };
  operations = Object.entries(data.operations).map(([name, op]) => ({
    name,
    description: op.description,
    input_schema: op.input_schema,
  }));
  process.stderr.write(`switch: serving ${operations.length} operations locally\n`);
}

/**
 * Whether the server rejected a call because the connection it was stamped with
 * no longer exists.
 *
 * Two status codes for one condition: `/ops/*` answers 409 and `/connection/*`
 * answers 404, so matching on either alone misses half the surface. The id is
 * checked too — a 409 naming some *other* connection is a different fault and
 * must not be dressed up as this one.
 */
function isDeadConnection(status: number, body: string): boolean {
  if (status !== 409 && status !== 404) return false;
  return body.includes(CONNECTION_ID) && body.includes('is not open');
}

/** Whether the operator has already been told this connection is dead. */
let deadConnectionReported = false;

/**
 * Explain a dead connection instead of passing the server's wording through.
 *
 * Raw, the rejection reads `409: connection <uuid> is not open; reconnect and
 * resume from your cursor` — advice this process cannot take when the id was
 * handed to it by a supervisor. It is fixed for the life of the process, so
 * every retry fails identically. Meanwhile events keep arriving on the
 * supervisor's own stream, so the session reads the room perfectly and is
 * simply unable to answer: exactly the shape of failure that looks healthy.
 *
 * Say what happened, and that a restart is the only way out.
 */
function deadConnectionMessage(operation: string): string {
  if (!OWNS_CONNECTION) {
    if (!deadConnectionReported) {
      deadConnectionReported = true;
      process.stderr.write(
        `switch: FATAL — the supervisor's connection (${CONNECTION_ID}) is gone. ` +
          'It restarted after handing this session the id, and the id cannot be ' +
          'refreshed from here. Every Switch tool call will fail until this ' +
          'session is restarted.\n'
      );
    }
    return (
      `Switch is unreachable from this session: ${operation} was refused because ` +
      `connection ${CONNECTION_ID} no longer exists on the server.\n\n` +
      'The supervisor that launched this session (switchdash, or the sidecar on ' +
      'this host) handed over that connection and has since restarted. The id ' +
      'was read once at startup and cannot be refreshed, so this is permanent ' +
      'for this session — retrying will fail the same way.\n\n' +
      'Note that incoming events may still be arriving normally, so the session ' +
      'looks fine while being unable to post anything. Tell the user plainly ' +
      'that you cannot reach Switch and that the session has to be restarted.'
    );
  }
  process.stderr.write(`switch: connection ${CONNECTION_ID} lapsed and was refused\n`);
  return (
    `Switch refused ${operation}: connection ${CONNECTION_ID} had lapsed. This ` +
    'process owns that connection, so its heartbeat reopens the stream on the ' +
    'same id within a couple of seconds — retry the call.'
  );
}

async function callOperation(
  name: string,
  args: Record<string, unknown>
): Promise<{
  isError?: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
}> {
  try {
    const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/ops/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        // Correlation, supplied by the process that owns the connection.
        'X-Switch-Connection-Id': CONNECTION_ID,
      },
      body: JSON.stringify(args),
    });
    const text = await resp.text();
    if (!resp.ok) {
      if (isDeadConnection(resp.status, text)) {
        return { isError: true, content: [{ type: 'text', text: deadConnectionMessage(name) }] };
      }
      return { isError: true, content: [{ type: 'text', text: `${resp.status}: ${text}` }] };
    }
    const data = JSON.parse(text) as { result?: unknown };
    const result = data.result ?? null;
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
      // Object results are also returned as structured content. The remote MCP
      // server produced this for free (FastMCP derives it from the return
      // type), and hosts read the tool's *fields* from it — switchdash's
      // connect_to_room hook takes room_id and agent_id straight off the tool
      // response. Text alone leaves them with a blob they cannot address, so
      // the session silently never gets bound to its room.
      ...(result !== null && typeof result === 'object' && !Array.isArray(result)
        ? { structuredContent: result as Record<string, unknown> }
        : {}),
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `${name} failed: ${err}` }] };
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...operations.map((op) => ({
      name: op.name,
      description: op.description,
      inputSchema: op.input_schema,
    })),
    DOWNLOAD_ATTACHMENT_TOOL,
    SEND_ATTACHMENT_TOOL,
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === 'download_attachment') {
    return handleDownloadAttachment(req.params.arguments ?? {});
  }
  if (name === 'send_attachment') {
    return handleSendAttachment(req.params.arguments ?? {});
  }
  if (operations.some((op) => op.name === name)) {
    const result = await callOperation(name, req.params.arguments ?? {});
    // connect_to_room binds the room to this connection; keep the local view
    // in step so attachments and missed-counts target the right room.
    if (name === 'connect_to_room' && !result.isError) {
      const roomId = (req.params.arguments ?? {}).room_id;
      if (typeof roomId === 'string') setConnectedRoom(roomId);
    }
    return result;
  }
  throw new Error(`Unknown tool: ${name}`);
});

async function handleDownloadAttachment(rawArgs: Record<string, unknown>) {
  const args = rawArgs as {
    mxc?: string;
    filename?: string;
    room_id?: string;
  };
  const mxc = typeof args.mxc === 'string' ? args.mxc : '';
  if (!mxc) {
    return { isError: true, content: [{ type: 'text', text: 'mxc is required' }] };
  }
  const roomId = args.room_id ?? pollingRoomId;
  if (!roomId) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Not connected to a room — call connect_to_room first or pass room_id.',
        },
      ],
    };
  }
  const mediaId = mxc.split('/').pop() || 'attachment';
  const destName = `${sanitiseName(mediaId)}-${sanitiseName(args.filename ?? '')}`;
  try {
    const path = await fetchMediaToFile(roomId, mxc, destName);
    return { content: [{ type: 'text', text: path }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Download failed: ${err}` }],
    };
  }
}

// Extension → mimetype map. Anything unlisted goes up as
// application/octet-stream, which still relays fine — the mapping exists to
// preserve type fidelity so platforms render/preview the file properly.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

async function handleSendAttachment(rawArgs: Record<string, unknown>) {
  const args = rawArgs as {
    path?: string;
    paths?: unknown;
    caption?: string;
    thread_id?: string;
    room_id?: string;
  };
  const filePaths: string[] = [];
  if (typeof args.path === 'string' && args.path) filePaths.push(args.path);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) if (typeof p === 'string' && p) filePaths.push(p);
  }
  if (filePaths.length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'path (or paths) is required' }],
    };
  }
  const roomId = args.room_id ?? pollingRoomId;
  if (!roomId) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Not connected to a room — call connect_to_room first or pass room_id.',
        },
      ],
    };
  }

  // Read every file up front: one unreadable path fails the whole call rather
  // than posting a partial message.
  const files: { name: string; bytes: Buffer; mimetype: string }[] = [];
  for (const filePath of filePaths) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Cannot read ${filePath}: ${err}` }],
      };
    }
    files.push({
      name: path.basename(filePath),
      bytes,
      mimetype: MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
  }

  const form = new FormData();
  for (const file of files) {
    form.append('files', new Blob([file.bytes], { type: file.mimetype }), file.name);
  }
  if (typeof args.caption === 'string' && args.caption) form.append('caption', args.caption);
  if (typeof args.thread_id === 'string' && args.thread_id)
    form.append('thread_id', args.thread_id);

  try {
    const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/rooms/${roomId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      body: form,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as { event_id?: string };
    const names = files.map((f) => f.name).join(', ');
    return {
      content: [
        {
          type: 'text',
          text:
            `Sent ${files.length === 1 ? names : `${files.length} files (${names})`} ` +
            `to the room (event_id: ${data.event_id ?? 'unknown'}).`,
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Send failed: ${err}` }],
    };
  }
}

// -- Event stream (SSE) ------------------------------------------------------
//
// One long-lived HTTP request the server writes events into as they happen.
// Catch-up from our cursor comes first, then live delivery. On any drop we
// reopen with the same connection id and Last-Event-ID, and the server resumes
// from where we stopped — the gap fills itself rather than being lost.

function stopStream() {
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
  pollingRoomId = null;
}

function startStream() {
  // A borrowed connection belongs to the supervisor: it holds the stream and
  // the heartbeat. Opening a second stream on the same id would take the
  // connection over — the server treats a reopen as the client returning — and
  // the supervisor would stop receiving anything.
  if (!OWNS_CONNECTION) return;
  if (streamAbort) return;
  const abort = new AbortController();
  streamAbort = abort;

  void (async () => {
    let backoff = 1000;

    while (!abort.signal.aborted) {
      try {
        const params = new URLSearchParams({
          connection_id: CONNECTION_ID,
          scope: 'single',
          filter: 'all',
          start_from: cursor > 0 ? String(cursor) : 'head',
        });
        // Declare the room when opening, not after: catch-up runs immediately,
        // and a room subscribed afterwards would arrive too late for the
        // buffered events this reconnect exists to recover.
        //
        // Not when switchdash is managing this session, though. It runs its own
        // connection for the room and claims the slot; a second claim from here
        // would be refused, and whichever of us lost would sit in a reconnect
        // loop delivering nothing. Suppressing the *notification* was never
        // enough — the claim has to be suppressed too.
        if (pollingRoomId && !SUPPRESS_NOTIFICATIONS) {
          params.set('rooms', pollingRoomId);
        }
        const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/events?${params}`, {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            Accept: 'text/event-stream',
            ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
          },
          signal: abort.signal,
        });

        if (!resp.ok || !resp.body) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }

        backoff = 1000;
        process.stderr.write(
          `switch: stream open (connection ${CONNECTION_ID}, cursor ${cursor})\n`
        );

        for await (const frame of readSse(resp.body, abort.signal)) {
          if (frame.id) cursor = Math.max(cursor, Number(frame.id) || 0);
          await handleFrame(frame);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        process.stderr.write(`switch: stream error: ${err}, reconnecting in ${backoff / 1000}s\n`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();
}

async function handleFrame(frame: SseFrame): Promise<void> {
  switch (frame.event) {
    case 'connection_state':
      process.stderr.write(
        `switch: connection established (rooms=${JSON.stringify(frame.data.rooms)})\n`
      );
      return;

    case 'subscription_changed':
      process.stderr.write(`switch: subscription now ${JSON.stringify(frame.data.rooms)}\n`);
      return;

    case 'gap':
      // Never silent, but never a wake either: logged here and held for the
      // next notification, rather than spending a turn to say "you may have
      // missed something you may not care about".
      process.stderr.write(
        `switch: GAP — missed events before sequence ${frame.data.from_sequence}\n`
      );
      pendingGapReason = String(frame.data.reason ?? 'events were dropped and cannot be replayed');
      return;

    case 'evicted':
      process.stderr.write(`switch: evicted — ${frame.data.reason}\n`);
      return;

    default:
      if (SUPPRESS_NOTIFICATIONS) {
        // Consumed, not surfaced: the cursor still advances, so resuming after
        // a drop stays correct even though switchdash is doing the telling.
        return;
      }
      await handleEvent(frame.data as unknown as AgentEvent);
  }
}

// -- Room reconciliation ------------------------------------------------------

// There is no subscribeRoom any more: `connect_to_room` claims the room on the
// calling connection server-side, so a client-side follow-up would be a second
// way to say the same thing — and, on a managed session, a way to take a slot
// that belongs to the supervisor. Releasing is still explicit, below.

async function unsubscribeRoom(roomId: string): Promise<void> {
  try {
    await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/connection/unsubscribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ connection_id: CONNECTION_ID, room_id: roomId }),
    });
  } catch (err) {
    process.stderr.write(`switch: unsubscribe failed for ${roomId}: ${err}\n`);
  }
}

function setConnectedRoom(target: string | null) {
  if (target === pollingRoomId) return;

  const previous = pollingRoomId;

  if (previous) {
    process.stderr.write(`switch: leaving room ${previous}\n`);
    // Only release a slot we hold. On a borrowed connection the claim belongs
    // to the supervisor's stream, and connect_to_room repoints it for us —
    // releasing here would blank the supervisor's room between the two calls.
    if (OWNS_CONNECTION) void unsubscribeRoom(previous);
    pollingRoomId = null;
  }

  if (target) {
    pollingRoomId = target;
    missedSinceRead = 0;

    process.stderr.write(
      `switch: joining room ${target}` +
        (OWNS_CONNECTION ? '' : ' (connection shared with the supervisor)') +
        (SUPPRESS_NOTIFICATIONS ? ' (notifications suppressed: switchdash-managed)' : '') +
        '\n'
    );

    if (!OWNS_CONNECTION) {
      // The supervisor holds the stream on this connection, and the server has
      // already claimed the room on it — connect_to_room does that now. So the
      // supervisor has been told, and there is nothing for us to open, claim or
      // reopen. This branch is the whole point of sharing the connection.
      return;
    }

    startStream();
    startHeartbeat();
    if (SUPPRESS_NOTIFICATIONS) {
      // Managed session on an older supervisor that did not hand us an id: it
      // runs its own connection for this room and owns the slot, so ours must
      // not compete for a room it is not serving. Kept for switchdash releases
      // in the wild; the shared-connection path above replaces it.
      return;
    }
    // The room is already claimed server-side by connect_to_room. What is left
    // is catch-up: the stream may have opened before the room was known, in
    // which case it skipped that room's buffered events. Reopening declares the
    // room up front and resumes from our cursor — which is still behind those
    // events, because we never received them.
    if (streamAbort && !streamHasRoom) {
      streamHasRoom = true;
      restartStream();
    }
  }
}

// -- Connection heartbeat ----------------------------------------------------
//
// One tick, every 2s, carrying the cursor. It proves this client is alive AND
// consuming — strictly stronger than the server observing an open socket — and
// tells the server how far we have read. The server drops the connection when
// these stop, releasing its room slot; it rejects them when no stream is
// attached, so a session that is somehow acting without receiving is told
// rather than left believing it is connected.

const HEARTBEAT_INTERVAL_MS = 2000;

function stopHeartbeat() {
  if (heartbeatAbort) {
    heartbeatAbort.abort();
    heartbeatAbort = null;
  }
}

function startHeartbeat() {
  // The supervisor beats for a borrowed connection. Two heartbeats would not
  // conflict, but they would disagree about the cursor: ours only advances on
  // events we receive, and on a borrowed connection we receive none — so ours
  // would keep reporting 0 and undo the supervisor's progress.
  if (!OWNS_CONNECTION) return;
  if (heartbeatAbort) return;
  const abort = new AbortController();
  heartbeatAbort = abort;

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/connection/beat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ connection_id: CONNECTION_ID, cursor }),
          signal: abort.signal,
        });
        if (resp.status === 409 || resp.status === 404) {
          // Either the stream is gone or the connection expired. Both mean we
          // are not receiving; reopening resumes from the cursor.
          process.stderr.write(
            `switch: heartbeat rejected (HTTP ${resp.status}) — reopening stream\n`
          );
          stopStreamKeepingRoom();
          startStream();
          // No re-claim here. When we own the connection and serve the room,
          // reopening declares it on the URL; when the supervisor serves it,
          // the slot is the supervisor's and claiming would take it away.
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        process.stderr.write(`switch: heartbeat error: ${err}\n`);
      }
      await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
    }
  })();
}

function restartStream() {
  stopStreamKeepingRoom();
  startStream();
}

function stopStreamKeepingRoom() {
  const room = pollingRoomId;
  stopStream();
  pollingRoomId = room;
}

// -- Role lease renewal ------------------------------------------------------
//
// While this session holds a room-role, renew the lease on a fast cadence so an
// (exclusive) seat stays held. The server frees a lease shortly after renewals
// stop (TTL), so a crashed/closed session auto-releases. release_role and a
// clean disconnect stop the loop immediately.

const LEASE_RENEW_INTERVAL_MS = 2000;

function stopLeaseRenew() {
  if (leaseAbort) {
    leaseAbort.abort();
    leaseAbort = null;
  }
}

function startLeaseRenew() {
  if (leaseAbort) return; // already renewing
  const abort = new AbortController();
  leaseAbort = abort;

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const resp = await fetch(`${API_ENDPOINT}/agents/${AGENT_ID}/leases/renew`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_TOKEN}` },
          signal: abort.signal,
        });
        if (resp.ok) {
          const data = (await resp.json()) as { held?: boolean };
          // The server says we hold no lease — nothing to renew, stop the loop.
          if (data.held === false) {
            stopLeaseRenew();
            return;
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        process.stderr.write(`switch: lease renew error: ${err}\n`);
      }
      await new Promise((r) => setTimeout(r, LEASE_RENEW_INTERVAL_MS));
    }
  })();
}

// -- Hook listener: localhost-only port advertised via PORT_FILE ------------

function publishPort(port: number) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port));
}

function unpublishPort() {
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`switch: failed to clean up ${SESSION_DIR}: ${err}\n`);
  }
}

/**
 * The hook routes, as a Web-standard handler.
 *
 * Kept in Request/Response terms rather than node's (req, res): it is the
 * clearer shape for routing, and it is what this was written against. The
 * node:http bridge below is the only thing that had to change when the runtime
 * stopped requiring Bun.
 */
async function handleHookRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  if (url.pathname === '/connect') {
    let body: { room_id?: unknown };
    try {
      body = (await req.json()) as { room_id?: unknown };
    } catch {
      return new Response('bad json', { status: 400 });
    }
    const roomId = typeof body.room_id === 'string' ? body.room_id : null;
    if (!roomId) {
      return new Response('missing room_id', { status: 400 });
    }
    setConnectedRoom(roomId);
    return new Response('ok');
  }

  if (url.pathname === '/disconnect') {
    setConnectedRoom(null);
    stopLeaseRenew();
    return new Response('ok');
  }

  if (url.pathname === '/assume-role') {
    startLeaseRenew();
    return new Response('ok');
  }

  if (url.pathname === '/release-role') {
    stopLeaseRenew();
    return new Response('ok');
  }

  if (url.pathname === '/read-context') {
    // The agent called read_context, so it has caught up on room history —
    // clear the missed-message backlog we've been tallying, and any deferred
    // gap warning: re-reading context is exactly the recovery that warning
    // would have asked for, so repeating it later would be noise.
    missedSinceRead = 0;
    pendingGapReason = null;
    return new Response('ok');
  }

  if (url.pathname === '/turn-end') {
    // The Claude Code turn finished. Clear the "thinking" indicator in case
    // the agent ended without posting a reply — Slack's faked indicator is
    // a real message that lingers until explicitly deleted (the reply path
    // clears it server-side, but a no-reply turn would otherwise leave it).
    if (pollingRoomId) void setTyping(pollingRoomId, false);
    return new Response('ok');
  }

  return new Response('not found', { status: 404 });
}

function startHookListener() {
  const server = http.createServer((nodeReq, nodeRes) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
        const req = new Request(`http://127.0.0.1${nodeReq.url ?? '/'}`, {
          method: nodeReq.method ?? 'GET',
          // A GET/HEAD with a body is a TypeError, and every route here is a
          // POST, but the guard keeps a stray probe from crashing the listener.
          body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
        });
        const res = await handleHookRequest(req);
        nodeRes.writeHead(res.status);
        nodeRes.end(await res.text());
      } catch (err) {
        // The hooks are how the session tells us it changed room. Failing one
        // silently would leave us serving the wrong room with no sign why.
        process.stderr.write(`switch: hook request failed: ${err}\n`);
        if (!nodeRes.headersSent) nodeRes.writeHead(500);
        nodeRes.end('hook failed');
      }
    })();
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    publishPort(port);
    process.stderr.write(
      `switch: hook listener on http://127.0.0.1:${port} (published to ${PORT_FILE})\n`
    );
  });
}

// -- Event handling ----------------------------------------------------------

async function handleEvent(event: AgentEvent) {
  const { type, room_id, payload } = event;

  if (type === 'message') {
    const msg = payload as MessagePayload;
    if (!msg.addressed) {
      // Unaddressed chatter: filtered out, no notification. Tally it so the
      // next notification can tell the agent how far behind it has fallen.
      missedSinceRead++;
      return;
    }

    // Surface receipt feedback: tell the room's bridged channel that this
    // agent is "typing" so the human knows the message landed and we're
    // working on a reply. Fire-and-forget — typing feedback must never block
    // or fail event delivery. The indicator is cleared when the agent posts
    // its reply, and on turn end via the Stop hook (`/turn-end`) for the case
    // where the agent finishes without replying.
    void setTyping(room_id, true);

    // Materialise every attachment to a local file so Claude can Read it,
    // whatever the type. Images are surfaced as image_path (Claude renders
    // them); everything else as file_path. A download that fails is reported
    // as failed_attachment rather than being dropped quietly.
    const imagePaths: string[] = [];
    const filePaths: string[] = [];
    const failedAttachments: string[] = [];
    const attachments = msg.attachments ?? [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const localPath = await downloadAttachment(room_id, att, msg.message_id, i);
      if (!localPath) {
        failedAttachments.push(att.filename);
        continue;
      }
      if (att.mimetype.startsWith('image/')) imagePaths.push(localPath);
      else filePaths.push(localPath);
    }

    const ts = new Date(msg.timestamp).toISOString();
    await emitNotification(`[${msg.sender_name}]: ${msg.body}`, {
      room_id,
      event_type: type,
      sender: msg.sender,
      sender_name: msg.sender_name,
      message_id: msg.message_id,
      timestamp: ts,
      // Lets an addressed agent reply back into the same thread.
      ...(msg.thread_id ? { thread_id: msg.thread_id } : {}),
      ...(imagePaths.length ? { image_path: imagePaths.join(',') } : {}),
      ...(filePaths.length ? { file_path: filePaths.join(',') } : {}),
      ...(failedAttachments.length ? { failed_attachments: failedAttachments.join(',') } : {}),
    });
    return;
  }

  if (type === 'command') {
    const cmd = payload as CommandPayload;
    await emitNotification(`Command: ${cmd.command}${cmd.target ? ` target=${cmd.target}` : ''}`, {
      room_id,
      event_type: type,
      user_id: cmd.user_id,
      user_name: cmd.user_name,
    });
    return;
  }

  if (type === 'room_join') {
    const join = payload as RoomJoinPayload;
    // This agent is opted out of join events in this room — deliver nothing.
    if (!join.listening) {
      return;
    }
    await emitNotification(`${join.member_name} joined the room`, {
      room_id,
      event_type: type,
      member: join.member,
      member_name: join.member_name,
      timestamp: new Date(join.timestamp).toISOString(),
    });
    return;
  }

  if (type === 'task_delegate') {
    const task = payload as TaskDelegatePayload;
    await emitNotification(`Task delegated: ${task.summary} — ${task.description}`, {
      room_id,
      event_type: type,
      task_id: task.task_id,
      requester_agent_id: task.requester_agent_id,
      performer_agent_id: task.performer_agent_id,
      summary: task.summary,
    });
    return;
  }

  if (type === 'task_accept') {
    const task = payload as TaskAcceptPayload;
    await emitNotification(`Task accepted by ${task.performer_agent_id}`, {
      room_id,
      event_type: type,
      task_id: task.task_id,
      requester_agent_id: task.requester_agent_id,
      performer_agent_id: task.performer_agent_id,
    });
    return;
  }

  if (type === 'task_update') {
    const task = payload as TaskUpdatePayload;
    await emitNotification(`Task update: ${task.update}`, {
      room_id,
      event_type: type,
      task_id: task.task_id,
      requester_agent_id: task.requester_agent_id,
      performer_agent_id: task.performer_agent_id,
    });
    return;
  }

  if (type === 'task_finalise') {
    const task = payload as TaskFinalisePayload;
    await emitNotification(`Task finalised: ${task.outcome ?? '(no outcome provided)'}`, {
      room_id,
      event_type: type,
      task_id: task.task_id,
      requester_agent_id: task.requester_agent_id,
      performer_agent_id: task.performer_agent_id,
    });
    return;
  }

  if (type === 'task_cancel') {
    const task = payload as TaskCancelPayload;
    await emitNotification(`Task cancelled${task.reason ? `: ${task.reason}` : ''}`, {
      room_id,
      event_type: type,
      task_id: task.task_id,
      requester_agent_id: task.requester_agent_id,
      performer_agent_id: task.performer_agent_id,
    });
    return;
  }

  process.stderr.write(`switch: unknown event type: ${type}\n`);
}

const MEDIA_DIR = path.join(SESSION_DIR, 'media');

// Download an inbound attachment from the agent bridge to a local file so the
// agent can read it. The bridge proxies the bytes out of the Matrix media repo
// (this runtime holds only the bridge API token, not Matrix creds).
// Returns the local path, or null on failure (logged, never throws).
function sanitiseName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

// Fetch an attachment's bytes from the agent bridge (which proxies the Matrix
// media repo) and write them to a local file under MEDIA_DIR. Throws on error.
async function fetchMediaToFile(roomId: string, mxc: string, destName: string): Promise<string> {
  const url =
    `${API_ENDPOINT}/agents/${AGENT_ID}/rooms/${roomId}/media` + `?mxc=${encodeURIComponent(mxc)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const dest = path.join(MEDIA_DIR, destName);
  fs.writeFileSync(dest, bytes);
  return dest;
}

// Notification path: best-effort download (failures are logged, never thrown,
// so they can't break event delivery). Returns the local path or null.
async function downloadAttachment(
  roomId: string,
  att: AttachmentRef,
  messageId: string,
  index: number
): Promise<string | null> {
  try {
    const destName = `${messageId.replace(/[^a-zA-Z0-9]/g, '_')}-${index}-${sanitiseName(att.filename)}`;
    return await fetchMediaToFile(roomId, att.mxc, destName);
  } catch (err) {
    process.stderr.write(`switch: attachment download error: ${err}\n`);
    return null;
  }
}

async function setTyping(roomId: string, isTyping: boolean) {
  try {
    const url = `${API_ENDPOINT}/agents/${AGENT_ID}/typing`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room_id: roomId, is_typing: isTyping }),
    });
    if (!resp.ok) {
      process.stderr.write(
        `switch: set typing failed: HTTP ${resp.status}: ${await resp.text()}\n`
      );
    }
  } catch (err) {
    process.stderr.write(`switch: set typing error: ${err}\n`);
  }
}

async function emitNotification(content: string, meta: Record<string, string>) {
  // Surface the unaddressed-message backlog on every notification. meta values
  // are strings; missed_count is always present (0 when caught up). When it's
  // non-zero, annotate the one-line body so the agent sees it without having
  // to inspect meta, and knows to widen read_context's `since` to catch up.
  const missed = missedSinceRead;
  const enriched: Record<string, string> = { ...meta, missed_count: String(missed) };
  let body =
    missed > 0
      ? `${content}\n⚠️ ${missed} unread room message${missed === 1 ? '' : 's'} since your last read_context — call read_context (widen \`since\`) to catch up on what you missed.`
      : content;

  // Deliver any deferred gap on the way past. This is the turn the agent was
  // already being woken for, so the warning is free here, and it lands before
  // the reply it would otherwise have skewed.
  if (pendingGapReason !== null) {
    enriched.gap = pendingGapReason;
    body = `${body}\n⚠️ Some earlier room events were dropped and cannot be replayed (${pendingGapReason}) — call read_context before responding.`;
    pendingGapReason = null;
  }
  await mcp
    .notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta: enriched },
    })
    .catch((err) => {
      process.stderr.write(`switch: failed to deliver event to Claude: ${err}\n`);
    });
}

// -- Connect and start -------------------------------------------------------

const transport = new StdioServerTransport();

transport.onclose = () => {
  stopStream();
  stopHeartbeat();
  stopLeaseRenew();
  unpublishPort();
  process.exit(0);
};

// Wipe any stale port file left by a crashed previous process for the same ppid.
// Safe: the previous process for this ppid is gone (we are it now); a live
// sibling would be a different ppid.
unpublishPort();

// Load the operation list before serving: a tool surface that is empty
// because a fetch failed is worse than a process that refuses to start.
try {
  await loadOperations();
} catch (err) {
  failStartup(
    `cannot reach Switch at ${API_ENDPOINT} to load its operations: ${err instanceof Error ? err.message : err}`
  );
}

await mcp.connect(transport);
serving = true;

startHookListener();

// The connection exists for the life of this process, not just while a room is
// attached: it is what correlates every tool call, and what the server uses to
// know this agent is reachable at all.
startStream();
startHeartbeat();

process.stderr.write(`switch: running (agent_id=${AGENT_ID})\n`);
