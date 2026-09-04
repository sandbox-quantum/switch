import type {
  ApprovalDecision,
  ApprovalOption,
  ItemStatus,
  ItemType,
  RequestType,
  UserInputAnswers,
  UserInputQuestion,
} from '@switch-console/agent-providers';
import { defineEvent } from '@shared/lib/ipc/events';

/**
 * How a session drives its agent. `pty` is the tmux/TUI path; `provider` is a
 * `@switch-console/agent-providers` adapter with a transcript instead of a
 * terminal. Absent means `pty`.
 */
export type SessionRuntimeKind = 'pty' | 'provider';

export type TranscriptTurnStatus = 'running' | 'completed' | 'interrupted' | 'error';

export interface TranscriptTurn {
  turnId: string;
  status: TranscriptTurnStatus;
  startedAt: string;
  endedAt?: string;
  message?: string;
}

export interface TranscriptItem {
  type: ItemType;
  status: ItemStatus;
  title: string;
  text?: string;
  toolName?: string;
}

/** Where a user message came from, so the transcript can label room traffic. */
export type TranscriptUserSource = 'console' | 'room' | 'system';

export type TranscriptEntry =
  | {
      kind: 'user';
      id: string;
      turnId: string;
      text: string;
      source: TranscriptUserSource;
      createdAt: string;
    }
  | {
      kind: 'assistant';
      id: string;
      turnId: string;
      text: string;
      streaming: boolean;
      createdAt: string;
    }
  | { kind: 'item'; id: string; turnId: string; item: TranscriptItem; createdAt: string }
  | {
      kind: 'request';
      id: string;
      turnId: string;
      requestType: RequestType;
      title: string;
      detail?: string;
      options: ApprovalOption[];
      state: 'open' | 'resolved';
      decision?: ApprovalDecision;
      createdAt: string;
    }
  | {
      kind: 'question';
      id: string;
      turnId: string;
      questions: UserInputQuestion[];
      state: 'open' | 'resolved';
      answers?: UserInputAnswers;
      createdAt: string;
    }
  | {
      kind: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
      createdAt: string;
    };

export type TranscriptSessionState = 'starting' | 'ready' | 'running' | 'stopped' | 'error';

/** The full state the renderer needs to draw a provider session. */
export interface SessionTranscript {
  sessionId: string;
  state: TranscriptSessionState;
  entries: TranscriptEntry[];
  turns: TranscriptTurn[];
  /** Ids of `request`/`question` entries still waiting on a person. */
  pendingInputIds: string[];
}

/**
 * Incremental updates for one session. `entry` inserts or replaces the entry
 * with that id (assistant text arrives as `delta` appends to an existing
 * `assistant` entry). Emitted on the topic `sessionId`.
 */
export type TranscriptUpdate =
  | { type: 'state'; state: TranscriptSessionState }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'delta'; entryId: string; delta: string }
  | { type: 'turn'; turn: TranscriptTurn }
  | { type: 'reset'; transcript: SessionTranscript };

export const sessionTranscriptChannel = defineEvent<{
  sessionId: string;
  update: TranscriptUpdate;
}>('session:transcript');

/**
 * RPC surface for provider sessions, served by `sessionTranscriptController`
 * and registered as `sessionTranscript` in `src/main/rpc.ts`. Every method
 * throws for a session that is not provider-backed.
 */
export interface SessionTranscriptRpc {
  get(params: { sessionId: string }): Promise<SessionTranscript>;
  sendTurn(params: { sessionId: string; text: string }): Promise<{ turnId: string }>;
  interrupt(params: { sessionId: string }): Promise<void>;
  respondToRequest(params: {
    sessionId: string;
    requestId: string;
    decision: ApprovalDecision;
  }): Promise<void>;
  respondToUserInput(params: {
    sessionId: string;
    requestId: string;
    answers: UserInputAnswers;
  }): Promise<void>;
}
