import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { commandSchema } from '@switch-console/shared/session-v1';
import type { Command, CommandStatus, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { ActivityReporter, type Report } from './activity-reporter';
import { stageAttachment, MAX_ATTACHMENT_BYTES } from './attachments';
import { HostWaker } from './handoff';
import { SharedRoomInbox, type roomConnectionSchema } from './room-inbox';
import {
  planAttachments,
  roomCommand,
  roomMessageSchema,
  type RoomAttachmentSource,
} from './room-prompt';
import { connectParent, type ParentChannel, type ParentPort } from './session-channel';
import { HostedSession } from './session-host';
import { startSessionMcp } from './session-mcp';
import { prepareSharedConfig, type SharedHostConfig } from './shared-config';
import { SharedState } from './shared-state';

/**
 * A session run on behalf of its agent.
 *
 * The host owns the session: its transcript, its generation (epoch) and its
 * recovery are its own and live in its state root. Switch holds none of it.
 * It is the child of whatever started it (Console for a local session, the
 * agent's sidecar for a remote one) and takes everything over that IPC
 * channel: room messages the agent's controller routed to it, commands from
 * Console, room controls and approval wakes. What it reports goes to the
 * `/agent-sessions` routes: a row per turn step, the requests a person can
 * answer, and the acknowledgement of answers it has applied.
 *
 * A host with a parent parks itself after `parkAfterMs` with nothing to do:
 * it records `parked` and exits, and its parent starts it again when the
 * session is next needed. A hundred quiet sessions then cost nothing.
 */
export type SharedHostOptions = {
  root: string;
  resumeOperationId?: string;
  authenticate?: () => Promise<void>;
  agentApiUrl: string;
  token: string;
  session: Session;
  input: ProviderSessionStartInput;
  roomConnection?: z.infer<typeof roomConnectionSchema>;
  grant?: { roomId: string; messageId: string };
  /** The IPC channel to the process that started this host, or null if none did. */
  parent: ParentChannel | null;
  /** How long the host waits with nothing to do before parking; null never parks. */
  parkAfterMs: number | null;
};

/** How long a session sits idle before its host parks, unless the environment says otherwise. */
const PARK_AFTER_MS = 30 * 60 * 1000;

/**
 * The park timeout for this process: `SWITCH_SESSION_PARK_AFTER_MS` in
 * milliseconds, `off` to never park, or 30 minutes when unset.
 */
export function parkAfterMs(): number | null {
  const value = process.env.SWITCH_SESSION_PARK_AFTER_MS;
  if (value === undefined || value === '') return PARK_AFTER_MS;
  if (value === 'off') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(
      `SWITCH_SESSION_PARK_AFTER_MS must be a positive number of milliseconds or "off", not "${value}".`
    );
  return parsed;
}

class TransportError extends Error {}
class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** How a room control names the session's current generation and turn. */
const CURRENT = 'current';

const approvalOutcomesSchema = z.array(
  z.object({
    sessionId: z.string(),
    requestId: z.string(),
    kind: z.enum(['approval', 'questions']),
    state: z.enum(['answered', 'expired']),
    answer: z.string().nullable(),
    // Stored as Switch took it from the platform, so its keys stay snake_case.
    answers: z
      .array(
        z.object({
          question_id: z.string(),
          selected_option_ids: z.array(z.string()),
          custom_text: z.string().nullable(),
        })
      )
      .nullable(),
    answeredBy: z.string().nullable(),
  })
);

export async function runSharedHost(
  options: SharedHostOptions,
  adapter: ProviderAdapter,
  signal: AbortSignal
): Promise<void> {
  const base = new URL(options.agentApiUrl);
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
    throw new Error('Shared host credentials require HTTPS or a loopback server.');
  if (base.username || base.password || base.search || base.hash)
    throw new Error('Agent API URL must not contain credentials, a query, or a fragment.');
  if (options.session.sessionId !== options.input.sessionId)
    throw new Error('Shared host session identity mismatch.');
  const state = await SharedState.open(options);
  const stopped = new AbortController();
  const executionSignal = AbortSignal.any([signal, stopped.signal]);
  const agentId = options.session.agentId;
  const sessionPath = `/${encodeURIComponent(options.session.sessionId)}`;
  const origin = base.href.replace(/\/$/, '');
  let host: HostedSession | null = null;
  let failure: unknown = null;
  let shutdown: Promise<void> | null = null;
  let reporting: Promise<void> | null = null;

  const callOnce = async (
    route: string,
    method: 'GET' | 'POST',
    body: unknown
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${origin}${route}`, {
        method,
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([executionSignal, AbortSignal.timeout(5000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (executionSignal.aborted) throw error;
      throw new TransportError(`Switch unavailable: ${String(error)}`);
    }
    if ([429, 500, 502, 503, 504].includes(response.status))
      throw new TransportError(`Switch unavailable (${response.status}).`);
    if (!response.ok) {
      const text = await response.text();
      let code = '';
      try {
        code = JSON.parse(text).code ?? '';
      } catch {
        /* The response may be plain text. */
      }
      throw new RequestError(
        code,
        response.status,
        `Switch refused ${route} (${response.status}): ${text}`
      );
    }
    return response.json();
  };
  /** Retried while Switch is unreachable; any answer, including a refusal, returns. */
  const agentSessions = async (path: string, method: 'GET' | 'POST', body: unknown) => {
    let disconnected = false;
    while (true) {
      executionSignal.throwIfAborted();
      try {
        const result = await callOnce(`/agent-sessions${path}`, method, body);
        if (disconnected) console.info('Connection to Switch restored.');
        return result;
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (!disconnected) console.warn(error.message);
        disconnected = true;
        await delay(500, undefined, { signal: executionSignal });
      }
    }
  };
  const stopExecution = async () => {
    if (host) {
      shutdown ??= host.shutdown();
      await shutdown;
    }
  };
  const onAbort = () => {
    void stopExecution().catch((error) => {
      failure ??= error;
    });
  };
  executionSignal.addEventListener('abort', onAbort, { once: true });

  try {
    // Names this session to its parent, which makes the agent's tool calls
    // as this session: the room it connects to is its own rather than its
    // connection's, which it shares with the agent's other sessions.
    let identified = '';
    const identify = (session: { hostId: string; epoch: string }) => {
      const identity = {
        agentId,
        sessionId: options.session.sessionId,
        hostId: session.hostId,
        epoch: session.epoch,
      };
      const key = JSON.stringify(identity);
      if (key === identified) return;
      identified = key;
      options.parent?.identify(identity);
    };
    identify(options.session);
    await state.journal.append({ type: 'running' });
    // Read whether or not this session serves rooms: it is also where the
    // agent's controller hands over commands Switch relayed from Console.
    const waker = new HostWaker();
    let lastActive = performance.now();
    const active = () => {
      lastActive = performance.now();
    };
    const rooms = options.roomConnection ? await SharedRoomInbox.open(options.root) : null;
    // Room attachments fetched ahead of the command that names them, so one
    // that cannot be fetched is left out and said, rather than failing the turn.
    const roomAttachments = new Map<string, { data: Uint8Array; sha256: string }>();
    const fetchRoomAttachment = async (
      source: RoomAttachmentSource,
      bytes: number
    ): Promise<{ data: Uint8Array; sha256: string }> => {
      const url = `${origin}/agents/${encodeURIComponent(agentId)}/rooms/${encodeURIComponent(source.roomId)}/media?mxc=${encodeURIComponent(source.mxc)}`;
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.any([executionSignal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (!response.ok || !response.body)
        throw new Error(`the room would not hand it over (${response.status})`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_ATTACHMENT_BYTES || size > bytes)
            throw new Error('it is larger than the room said');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data = Buffer.concat(chunks);
      if (data.byteLength !== bytes) throw new Error('it is not the size the room said');
      return { data, sha256: createHash('sha256').update(data).digest('hex') };
    };

    host = await HostedSession.start(
      options.root,
      {
        session: options.session,
        input: options.input,
        resumeOperationId: options.resumeOperationId,
        authenticate: options.authenticate,
        stageAttachments: (attachments) =>
          Promise.all(
            attachments.map((attachment) =>
              stageAttachment(options.root, attachment, async () => {
                const fetched = roomAttachments.get(attachment.attachmentId);
                if (!fetched)
                  throw new Error(
                    `Attachment ${attachment.name} is not one this session was given in a room, so there is nowhere to fetch it from.`
                  );
                roomAttachments.delete(attachment.attachmentId);
                return fetched;
              })
            )
          ),
      },
      adapter
    );

    // ── What the host reports ────────────────────────────────────────────────
    const reporter = await ActivityReporter.load(options.root);
    // A session first reporting here may have a long history behind it, and
    // reporting that would put cards up for requests settled long ago.
    if (reporter.fresh) await reporter.advance(host.replay(0).throughSequence);
    reporter.catchUp(host.replay(0).events.filter((event) => event.sequence <= reporter.cursor));
    let reportingUnsupported = false;
    const unsupported = (error: unknown): boolean => {
      if (!(error instanceof RequestError) || error.status !== 404 || error.code) return false;
      reportingUnsupported = true;
      console.warn(
        'This Switch server does not accept session activity or approval requests, so messaging platforms do not show what this session is doing.'
      );
      return true;
    };
    const send = async (report: Report): Promise<void> => {
      if (report.kind === 'activity')
        await agentSessions(`${sessionPath}/activity`, 'POST', report.row);
      else if (report.kind === 'approval.open')
        await agentSessions(`${sessionPath}/approvals`, 'POST', report.body);
      else
        await agentSessions(
          `${sessionPath}/approvals/${encodeURIComponent(report.requestId)}/close`,
          'POST',
          null
        );
    };
    const report = async () => {
      if (reportingUnsupported) return;
      const { events } = host!.replay(reporter.cursor);
      if (!events.length) return;
      for (const event of events) {
        for (const item of reporter.reports(event, (turnId) => host!.originOf(turnId))) {
          try {
            await send(item);
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            if (unsupported(error)) return;
            // A request Switch refused, or one opened before this session
            // first reported here, has nothing to close.
            if (item.kind === 'approval.close' && error.code === 'NOT_FOUND') continue;
            console.warn(
              `Switch refused ${item.kind} from session event ${event.sequence}; it is not shown on messaging platforms: ${error.message}`
            );
          }
        }
      }
      await reporter.advance(events.at(-1)!.sequence);
    };
    let outcomesCheckedAt = -Infinity;
    const applyOutcomes = async (force: boolean) => {
      if (reportingUnsupported) return;
      const woken = waker.takeApprovalWake();
      const waiting = host!.snapshot().requests.some((r) => r.state === 'open');
      // The watcher's wake is the prompt route; the interval only covers a
      // wake that was lost, and only while a person's answer is awaited.
      if (!force && !woken && !(waiting && performance.now() - outcomesCheckedAt >= 5000)) return;
      outcomesCheckedAt = performance.now();
      let listed: unknown;
      try {
        listed = await agentSessions('/approvals/outcomes', 'GET', null);
      } catch (error) {
        if (unsupported(error)) return;
        throw error;
      }
      for (const outcome of approvalOutcomesSchema.parse(listed)) {
        if (outcome.sessionId !== options.session.sessionId) continue;
        try {
          await host!.applyApprovalOutcome({
            requestId: outcome.requestId,
            kind: outcome.kind,
            state: outcome.state,
            answer: outcome.answer,
            answers:
              outcome.answers?.map((answer) => ({
                questionId: answer.question_id,
                selectedOptionIds: answer.selected_option_ids,
                customText: answer.custom_text,
              })) ?? null,
            answeredBy: outcome.answeredBy,
          });
        } catch (error) {
          if (String(error).includes('HOST_STOPPING')) throw error;
          console.error(
            `Could not apply the answer to request ${outcome.requestId}; it is settled as a provider error: ${String(error)}`
          );
        }
        await agentSessions(
          `${sessionPath}/approvals/${encodeURIComponent(outcome.requestId)}/delivered`,
          'POST',
          null
        );
      }
    };

    // ── What reaches the host ────────────────────────────────────────────────
    /**
     * A room control names the session's generation and turn as `current`:
     * Switch keeps neither, so the host puts in its own. Null for an
     * interrupt with no turn running, which has nothing to stop.
     */
    const current = (command: Command): Command | null => {
      const snapshot = host!.snapshot();
      const resolved =
        command.epoch === CURRENT ? { ...command, epoch: snapshot.session.epoch } : command;
      if (resolved.body.type !== 'turn.interrupt' || resolved.body.turnId !== CURRENT)
        return resolved;
      const running = snapshot.turns.find((turn) => turn.status === 'running');
      if (!running) return null;
      return { ...resolved, body: { ...resolved.body, turnId: running.turnId } };
    };
    /** Runs a command, answering with what the host recorded for it, or why it did not run. */
    const run = async (value: unknown): Promise<CommandStatus | string> => {
      executionSignal.throwIfAborted();
      active();
      const parsed = commandSchema.safeParse(value);
      if (!parsed.success) {
        console.warn(`Ignoring an unreadable session command: ${parsed.error.message}`);
        return `The command is not readable: ${parsed.error.message}`;
      }
      const command = current(parsed.data);
      if (!command) return 'There is no turn running to interrupt.';
      if (command.sessionId !== options.session.sessionId) {
        console.warn(`Ignoring command ${command.commandId}, which is for another session.`);
        return 'The command is for another session.';
      }
      // A command built against an earlier generation of the session was
      // about a conversation a reset or a restart has since replaced.
      if (command.epoch !== host!.snapshot().session.epoch)
        return 'STALE_EPOCH: the session has been reset or restarted since this command was made.';
      try {
        await host!.command(command);
      } catch (error) {
        await host!.reject(command, error);
      }
      return (
        host!.snapshot().commandStatuses.find((status) => status.commandId === command.commandId) ??
        'The host did not record the command.'
      );
    };
    /** Turn each room message handed over into the command it amounts to, in order. */
    const admitRoomMessages = async (inbox: SharedRoomInbox): Promise<void> => {
      for (const event of inbox.pending()) {
        const message = roomMessageSchema.safeParse(event.event);
        if (!message.success) {
          await host!.notice(
            `Room message ${event.messageId} reached this session without its content, so it could not be run. Ask the sender to address the agent again.`
          );
          await inbox.acknowledge(event);
          continue;
        }
        const attachments = planAttachments({
          roomId: event.roomId,
          message: message.data,
          supportedMimeTypes: host!.snapshot().session.capabilities.attachmentMimeTypes,
        });
        for (const planned of attachments) {
          if (planned.refused !== null) continue;
          try {
            roomAttachments.set(
              planned.attachmentId,
              await fetchRoomAttachment(planned.source, planned.bytes)
            );
          } catch (error) {
            if (executionSignal.aborted) throw error;
            planned.refused = `It could not be fetched: ${error instanceof Error ? error.message : String(error)}.`;
          }
        }
        const command = roomCommand({
          agentId,
          sessionId: options.session.sessionId,
          epoch: host!.snapshot().session.epoch,
          roomId: event.roomId,
          message: message.data,
          surface: 'switch-web',
          attachments,
        });
        // Taken by the host before the delivery is acknowledged: the host's
        // inbox is durable, so a crash between the two runs the message once
        // rather than losing it.
        await run(command);
        await inbox.acknowledge(event);
      }
    };

    identify(host.snapshot().session);
    // A parent that started this host talks to it over IPC: commands and room
    // messages come down the pipe, and every recorded event goes up it.
    const parent = options.parent;
    parent?.serve({
      command: async ({ command }) => {
        const outcome = await run(command);
        if (typeof outcome === 'string') throw new Error(outcome);
        return outcome;
      },
      room: async ({ handoff }) => {
        if (!rooms) throw new Error('This session serves no rooms.');
        await rooms.accept(handoff);
        active();
        waker.nudge();
        return { accepted: true };
      },
      snapshot: async () => host!.snapshot(),
      approvals: async () => {
        active();
        waker.approvalsWaiting();
        return null;
      },
    });
    host.onPublished(active);
    host.onPublished(() => identify(host!.snapshot().session));
    if (parent) {
      host.onPublished((event) => parent.push(event));
      parent.ready();
    }
    /** Nothing running, nothing waiting on a person, nothing handed over, for long enough. */
    const idleEnough = (): boolean => {
      if (!parent || options.parkAfterMs === null) return false;
      if (performance.now() - lastActive < options.parkAfterMs) return false;
      const snapshot = host!.snapshot();
      return (
        snapshot.session.status === 'ready' &&
        !host!.resetDecisionPending &&
        !snapshot.turns.some((turn) => turn.status === 'running') &&
        !snapshot.requests.some((request) => request.state === 'open') &&
        !(rooms?.pending().length ?? 0)
      );
    };
    // Reporting runs beside the session rather than in its way: while Switch
    // is unreachable the reports wait and retry, and the session keeps working.
    let reportingFailure: unknown = null;
    reporting = (async () => {
      let force = true;
      while (!executionSignal.aborted) {
        await report();
        await applyOutcomes(force);
        force = false;
        await waker.idleReporting(250, executionSignal);
      }
    })().catch((error: unknown) => {
      if (!executionSignal.aborted) reportingFailure = error;
    });
    let heldForDecision = false;
    while (!executionSignal.aborted) {
      if (reportingFailure) throw reportingFailure;
      const status = host.snapshot().session.status;
      if (status === 'stopped') break;
      if (status === 'error' && !host.resetDecisionPending)
        throw new Error(
          'HOST_FAULTED: Provider execution failed. Inspect the transcript before recovery.'
        );
      if (host.resetDecisionPending) heldForDecision = true;
      else if (heldForDecision) {
        heldForDecision = false;
        const held = rooms?.pending().length ?? 0;
        if (held) await host.roomBacklogDelivered(held);
      }
      if (rooms && ['ready', 'running'].includes(status)) await admitRoomMessages(rooms);
      if (idleEnough()) {
        console.info(
          `Parking session ${options.session.sessionId} after ${Math.round(options.parkAfterMs! / 1000)} s idle.`
        );
        // Stops answering first: a request that arrives now waits for the
        // exit, which the parent reads as the host being gone and starts it again.
        parent?.close();
        await state.journal.append({ type: 'parked' });
        break;
      }
      await waker.idle(250, executionSignal);
    }
  } catch (error) {
    if (!signal.aborted) failure ??= error;
  } finally {
    stopped.abort();
    await reporting;
    try {
      await stopExecution();
      await state.journal.append({ type: 'quiesced' });
    } catch (error) {
      if (failure)
        console.warn('Shared host cleanup failed after an earlier error:', String(error));
      failure ??= error;
    }
    executionSignal.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
}

/**
 * A session host as its own process: the child of Console or the agent's
 * sidecar, which it reaches over `port`.
 *
 * The Switch tools are served on loopback before the provider starts, so the
 * CLI is launched already pointing at them; every call goes up the pipe to
 * the parent. `authenticate` checks the provider's own sign-in with the
 * environment the CLI will get, where there is one to check.
 */
export async function hostSessionProcess(input: {
  root: string;
  config: SharedHostConfig;
  adapter: ProviderAdapter;
  port: ParentPort;
  authenticate: ((input: ProviderSessionStartInput) => Promise<void>) | null;
  signal: AbortSignal;
}): Promise<void> {
  const { config } = input;
  const parent = connectParent(input.port);
  const mcp = await startSessionMcp(parent);
  try {
    const prepared = await prepareSharedConfig(input.root, config, mcp.spec);
    const authenticate = input.authenticate;
    await runSharedHost(
      {
        root: resolve(input.root),
        agentApiUrl: prepared.agentApiUrl,
        token: prepared.token,
        session: config.session,
        resumeOperationId: config.resumeOperationId,
        ...(authenticate ? { authenticate: () => authenticate(prepared.input) } : {}),
        input: prepared.input,
        roomConnection: config.roomConnection,
        grant: config.grant,
        parent,
        parkAfterMs: parkAfterMs(),
      },
      input.adapter,
      input.signal
    );
  } finally {
    await mcp.close();
  }
}
