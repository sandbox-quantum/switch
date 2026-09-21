import type {
  OpencodeEvent,
  OpencodePermissionReply,
  OpencodePromptInput,
  OpencodeSessionTransport,
  OpencodeTransport,
  OpencodeTransportInput,
} from './transport';

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeSession extends OpencodeSessionTransport {
  readonly calls: FakeCall[];
  readonly opened: OpencodeTransportInput;
  push(event: OpencodeEvent): void;
  fail(reason: string): void;
  close(): void;
  status: 'busy' | 'idle' | 'unknown';
  promptRejection?: Error;
}

export interface FakeTransport extends OpencodeTransport {
  readonly sessions: FakeSession[];
  last(): FakeSession;
}

let counter = 0;

/**
 * Builds an OpenCode SSE event from just the fields the adapter reads. The
 * generated `Event` union carries whole `Message` and `Session` payloads that
 * no assertion here depends on, so the cast is the escape and it stays here.
 */
export function opencodeEvent(type: string, properties: Record<string, unknown>): OpencodeEvent {
  counter += 1;
  return { id: `evt_${counter}`, type, properties } as unknown as OpencodeEvent;
}

export function sessionStatus(sessionID: string, status: 'busy' | 'idle'): OpencodeEvent {
  return opencodeEvent('session.status', { sessionID, status: { type: status } });
}

export function messageUpdated(
  sessionID: string,
  id: string,
  role: 'user' | 'assistant'
): OpencodeEvent {
  return opencodeEvent('message.updated', { sessionID, info: { id, role } });
}

export function textPart(
  sessionID: string,
  messageID: string,
  id: string,
  text: string,
  done = false
): OpencodeEvent {
  return opencodeEvent('message.part.updated', {
    sessionID,
    time: 0,
    part: {
      id,
      sessionID,
      messageID,
      type: 'text',
      text,
      time: done ? { start: 0, end: 1 } : { start: 0 },
    },
  });
}

export function textDelta(
  sessionID: string,
  messageID: string,
  partID: string,
  delta: string
): OpencodeEvent {
  return opencodeEvent('message.part.delta', {
    sessionID,
    messageID,
    partID,
    field: 'text',
    delta,
  });
}

export function toolPart(
  sessionID: string,
  messageID: string,
  callID: string,
  tool: string,
  state: Record<string, unknown>
): OpencodeEvent {
  return opencodeEvent('message.part.updated', {
    sessionID,
    time: 0,
    part: { id: `prt_${callID}`, sessionID, messageID, type: 'tool', tool, callID, state },
  });
}

export function createFakeTransport(nativeSessionId = 'ses_fake'): FakeTransport {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    last() {
      const session = sessions[sessions.length - 1];
      if (session === undefined) throw new Error('no fake session has been opened');
      return session;
    },
    async open(input) {
      const queue: OpencodeEvent[] = [];
      const calls: FakeCall[] = [];
      const exitListeners = new Set<(reason: string) => void>();
      let wake: (() => void) | undefined;
      let closed = false;
      let failure: Error | undefined;
      const bump = () => {
        const resume = wake;
        wake = undefined;
        resume?.();
      };

      async function* stream(): AsyncGenerator<OpencodeEvent> {
        for (;;) {
          while (queue.length > 0) {
            const next = queue.shift();
            if (next !== undefined) yield next;
          }
          if (failure !== undefined) throw failure;
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }

      const record = (method: string, ...args: unknown[]) => {
        calls.push({ method, args });
      };

      const session: FakeSession = {
        nativeSessionId: input.resumeNativeSessionId ?? nativeSessionId,
        events: stream(),
        calls,
        opened: input,
        status: 'idle',
        push(event) {
          queue.push(event);
          bump();
        },
        fail(reason) {
          failure = new Error(reason);
          bump();
        },
        close() {
          closed = true;
          bump();
        },
        async prompt(promptInput: OpencodePromptInput) {
          record('prompt', promptInput);
          if (session.promptRejection !== undefined) throw session.promptRejection;
        },
        async abort() {
          record('abort');
        },
        async sessionStatus() {
          return session.status;
        },
        async replyPermission(requestId: string, reply: OpencodePermissionReply) {
          record('replyPermission', requestId, reply);
        },
        async replyQuestion(requestId: string, answers: string[][]) {
          record('replyQuestion', requestId, answers);
        },
        async rejectQuestion(requestId: string) {
          record('rejectQuestion', requestId);
        },
        onExit(listener) {
          exitListeners.add(listener);
        },
        async dispose() {
          record('dispose');
          closed = true;
          bump();
        },
      };
      sessions.push(session);
      return session;
    },
  };
}
