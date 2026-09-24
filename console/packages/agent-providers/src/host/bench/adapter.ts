import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HttpMcpServerSpec, ProviderAdapter, ProviderSendTurnInput } from '../../adapter';
import type { ApprovalDecision, ProviderItem, ProviderRuntimeEvent } from '../../events';
import {
  APPROVAL_APPLIED,
  APPROVAL_REQUESTED,
  PROVIDER_DISPATCH,
  REPLY_FAILED,
  REPLY_POSTED,
  ROOM_CONNECTED,
  traceRecord,
} from './trace';

/**
 * The token the benchmark driver embeds in the body of every room message it
 * posts, so a host can name the message it was handed.
 *
 * A host never learns the id Switch minted for that message: what reaches the
 * adapter is the command text, and the only part of it the benchmark controls
 * is the body it wrote. Reading the id back out of Switch's own wording would
 * measure the wording — a template change between two revisions would empty
 * the sample set rather than move the number, which is the failure mode a
 * revision-to-revision comparison can least afford.
 */
const MARKER = /switch-bench:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** In a message body: ask a person before answering. */
const APPROVE = 'switch-bench-approve';

/** In a message body: after answering, move this session to the named room. */
const CONNECT = /switch-bench-connect:(\S+)/;

/**
 * Where the room prompt names the message it carries. Only the reply's own
 * body uses it, so the driver can correlate the reply it sees arrive with the
 * message it answers; the room the reply lands in is Switch's choice.
 */
const ORIGIN = /addressed you in room (\S+) \(message_id ([^,\s)]+)/;

/** How long a refused `post_message` is tried again before the turn gives up. */
const REPLY_RETRY_MS = 90_000;

export function benchMarker(text: string): string | null {
  return MARKER.exec(text)?.[1] ?? null;
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

/**
 * One call to the session's Switch MCP server, the one its host serves on
 * loopback: what a real CLI does when its model uses a Switch tool. A server
 * that cannot be reached or answers outside the protocol throws; a tool that
 * ran and failed is an `isError` result, as MCP reports it.
 */
async function callTool(
  server: HttpMcpServerSpec,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...server.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`The session's Switch MCP server answered ${response.status}: ${text}`);
  const reply = JSON.parse(text) as { result?: ToolResult; error?: { message: string } };
  if (reply.error) throw new Error(`${name} was refused by MCP: ${reply.error.message}`);
  if (!reply.result) throw new Error(`${name} came back with neither a result nor an error.`);
  return reply.result;
}

/**
 * A scripted provider that answers every room message through the session's
 * own Switch tools, timestamped.
 *
 * The benchmark measures Switch's connection model, so the model has to be out
 * of the measurement: a real one would add seconds of latency, its own
 * processes and its own memory to every figure. What it keeps is everything a
 * real CLI does with Switch: it starts, runs a turn, calls `post_message`
 * (and `connect_to_room` when asked) on the MCP server its host serves, may
 * wait on a person's approval first, and finishes the turn. Each step is a
 * trace record the driver scores.
 */
export function createBenchAdapter(): ProviderAdapter {
  const servers = new Map<string, HttpMcpServerSpec>();
  const approvals = new Map<string, (decision: ApprovalDecision) => void>();
  const listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  const emit = (sessionId: string, event: Record<string, unknown>) => {
    const full = {
      ...event,
      sessionId,
      provider: 'claude',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of listeners) listener(full);
  };

  const tool = (
    turnId: string,
    name: string,
    status: ProviderItem['status'],
    text: string
  ): ProviderItem => ({
    id: `${turnId}:${name}`,
    type: 'mcp_tool_call',
    status,
    title: name,
    toolName: name,
    text,
  });

  const approve = async (sessionId: string, turnId: string, marker: string) => {
    const requestId = randomUUID();
    const decided = new Promise<ApprovalDecision>((resolve) => {
      approvals.set(`${sessionId}/${requestId}`, resolve);
    });
    emit(sessionId, {
      type: 'request.opened',
      turnId,
      requestId,
      requestType: 'tool_approval',
      title: 'Post the benchmark reply',
      detail: marker,
      options: [
        { decision: 'accept', label: 'Allow' },
        { decision: 'decline', label: 'Deny' },
      ],
    });
    traceRecord(APPROVAL_REQUESTED, marker, { sessionId, turnId, requestId });
    const decision = await decided;
    traceRecord(APPROVAL_APPLIED, marker, { sessionId, turnId, requestId, decision });
    return decision;
  };

  const reply = async (
    sessionId: string,
    turnId: string,
    marker: string,
    origin: { roomId: string; messageId: string }
  ): Promise<boolean> => {
    const server = servers.get(sessionId);
    if (!server)
      throw new Error(`Session ${sessionId} has no Switch MCP server to answer through.`);
    const body = `switch-bench-reply:${marker} room=${origin.roomId} message=${origin.messageId}`;
    emit(sessionId, {
      type: 'item.started',
      turnId,
      item: tool(turnId, 'post_message', 'in_progress', body),
    });
    const deadline = Date.now() + REPLY_RETRY_MS;
    const refusals: string[] = [];
    while (true) {
      const result = await callTool(server, 'post_message', { body });
      if (!result.isError) {
        traceRecord(REPLY_POSTED, marker, { sessionId, turnId, attempts: refusals.length + 1 });
        emit(sessionId, {
          type: 'item.completed',
          turnId,
          item: tool(turnId, 'post_message', 'completed', resultText(result)),
        });
        return true;
      }
      // A refusal is what a model sees when Switch is restarting or the
      // agent's connection is being reopened, and what it does is try again.
      refusals.push(resultText(result));
      if (Date.now() >= deadline) {
        traceRecord(REPLY_FAILED, marker, { sessionId, turnId, refusals });
        emit(sessionId, {
          type: 'item.completed',
          turnId,
          item: tool(turnId, 'post_message', 'failed', refusals.at(-1) ?? ''),
        });
        return false;
      }
      await delay(500);
    }
  };

  const connect = async (sessionId: string, turnId: string, marker: string, roomId: string) => {
    const server = servers.get(sessionId)!;
    emit(sessionId, {
      type: 'item.started',
      turnId,
      item: tool(turnId, 'connect_to_room', 'in_progress', roomId),
    });
    const result = await callTool(server, 'connect_to_room', {
      room_id: roomId,
      include_general_instructions: false,
    });
    const warning = result.structuredContent?.warning;
    traceRecord(ROOM_CONNECTED, marker, {
      sessionId,
      turnId,
      roomId,
      isError: result.isError === true,
      warning: typeof warning === 'string' ? warning : null,
      text: resultText(result),
    });
    emit(sessionId, {
      type: 'item.completed',
      turnId,
      item: tool(
        turnId,
        'connect_to_room',
        result.isError ? 'failed' : 'completed',
        resultText(result)
      ),
    });
  };

  const turn = async (input: ProviderSendTurnInput, marker: string) => {
    const { sessionId, turnId } = input;
    const origin = ORIGIN.exec(input.text);
    if (!origin) throw new Error(`Turn ${turnId} carries no room message to answer.`);
    if (input.text.includes(APPROVE) && (await approve(sessionId, turnId, marker)) !== 'accept')
      return 'interrupted' as const;
    const posted = await reply(sessionId, turnId, marker, {
      roomId: origin[1]!,
      messageId: origin[2]!,
    });
    const moveTo = CONNECT.exec(input.text)?.[1];
    if (posted && moveTo) await connect(sessionId, turnId, marker, moveTo);
    return posted ? ('completed' as const) : ('error' as const);
  };

  return {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: false,
      approvals: true,
      userInput: false,
      modelSwitchInSession: false,
    },
    startSession: async (input) => {
      const server = input.mcpServers.switch;
      if (server?.transport !== 'http')
        throw new Error(
          'The benchmark provider answers through the Switch MCP server its session host serves, and the host gave it none.'
        );
      servers.set(input.sessionId, server);
      // One id, announced and returned. A real provider's session has a single
      // native identity, and resuming one is how a host recovers a session it
      // did not start; a resume keeps the id it was handed, so a host that
      // quietly replaced a conversation shows as a second id.
      const nativeSessionId = input.resume?.nativeSessionId ?? randomUUID();
      emit(input.sessionId, { type: 'session.started', nativeSessionId });
      emit(input.sessionId, { type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude', sessionId: input.sessionId, nativeSessionId };
    },
    sendTurn: async (input: ProviderSendTurnInput) => {
      const marker = benchMarker(input.text);
      traceRecord(PROVIDER_DISPATCH, marker ?? `unmarked:${input.turnId}`, {
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      emit(input.sessionId, { type: 'turn.started', turnId: input.turnId });
      // The turn runs after this returns, as a real provider's does: the host
      // keeps reporting and applying answers while it waits on a person.
      void (async () => {
        let outcome: 'completed' | 'interrupted' | 'error' = 'completed';
        let message: string | undefined;
        try {
          if (marker) outcome = await turn(input, marker);
        } catch (error) {
          outcome = 'error';
          message = error instanceof Error ? error.message : String(error);
          if (marker) traceRecord(REPLY_FAILED, marker, { sessionId: input.sessionId, message });
        }
        emit(input.sessionId, {
          type: 'turn.completed',
          turnId: input.turnId,
          outcome,
          ...(message ? { message } : {}),
        });
      })();
      return { turnId: input.turnId };
    },
    interruptTurn: async () => {},
    respondToRequest: async (sessionId, requestId, decision) => {
      const key = `${sessionId}/${requestId}`;
      const resolve = approvals.get(key);
      if (!resolve) throw new Error(`Session ${sessionId} is not waiting on request ${requestId}.`);
      approvals.delete(key);
      resolve(decision);
    },
    respondToUserInput: async () => {},
    stopSession: async (sessionId) => {
      servers.delete(sessionId);
    },
    stopAll: async () => {
      servers.clear();
    },
    hasSession: (sessionId) => servers.has(sessionId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
