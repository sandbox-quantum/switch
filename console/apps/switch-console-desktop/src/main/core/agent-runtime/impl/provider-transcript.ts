import type { ProviderRuntimeEvent } from '@switch-console/agent-providers';
import type {
  SessionTranscript,
  TranscriptEntry,
  TranscriptSessionState,
  TranscriptTurn,
  TranscriptUpdate,
  TranscriptUserSource,
} from '@shared/core/sessions/session-transcript';

/**
 * How many entries one session's transcript keeps in memory.
 *
 * A provider session is a long-lived process whose transcript is only ever a
 * view: the durable record is the vendor's own, which `resume` reads back. So
 * this is bounded rather than grown, and the oldest entries are dropped — the
 * renderer scrolls back through what is here and no further.
 */
const MAX_ENTRIES = 5000;

/** Where the entries dropped by the cap are announced, once. */
const TRIM_NOTICE_ID = 'transcript-trimmed';

/**
 * Builds one session's `SessionTranscript` from the provider's event stream.
 *
 * Deliberately free of everything else — no adapter, no IPC, no database — so
 * the mapping from `ProviderRuntimeEvent` to what the renderer draws can be
 * asserted event by event. `ProviderAgentRuntime` owns an instance and forwards
 * whatever this returns.
 */
export class ProviderTranscript {
  private state: TranscriptSessionState = 'starting';
  private readonly entries: TranscriptEntry[] = [];
  private readonly entryIndex = new Map<string, TranscriptEntry>();
  private readonly turns: TranscriptTurn[] = [];
  private readonly turnIndex = new Map<string, TranscriptTurn>();
  /** Provider item id → the assistant entry deltas for it append to. */
  private readonly assistantEntries = new Map<string, string>();
  private trimmed = false;

  constructor(private readonly sessionId: string) {}

  snapshot(): SessionTranscript {
    return {
      sessionId: this.sessionId,
      state: this.state,
      entries: [...this.entries],
      turns: [...this.turns],
      pendingInputIds: this.entries
        .filter(
          (entry) =>
            (entry.kind === 'request' || entry.kind === 'question') && entry.state === 'open'
        )
        .map((entry) => entry.id),
    };
  }

  /** A turn the console or a room started, recorded before the provider sees it. */
  recordUserTurn(params: {
    turnId: string;
    text: string;
    source: TranscriptUserSource;
  }): TranscriptUpdate[] {
    return this.put({
      kind: 'user',
      id: `user:${params.turnId}`,
      turnId: params.turnId,
      text: params.text,
      source: params.source,
      createdAt: new Date().toISOString(),
    });
  }

  /** A line the app itself has to say — a control command, a degraded mode. */
  recordNotice(level: 'info' | 'warning' | 'error', text: string): TranscriptUpdate[] {
    return this.put({
      kind: 'notice',
      id: `notice:${this.entries.length}:${Date.now()}`,
      level,
      text,
      createdAt: new Date().toISOString(),
    });
  }

  /** Fold one provider event in, returning what changed. */
  apply(event: ProviderRuntimeEvent): TranscriptUpdate[] {
    switch (event.type) {
      case 'session.state.changed':
        return this.setState(event.status);
      case 'session.exited':
        return this.setState('stopped');
      case 'runtime.error':
        return [...this.setState('error'), ...this.recordNotice('error', event.message)];
      case 'runtime.warning':
        return this.recordNotice('warning', event.message);
      case 'turn.started':
        return this.putTurn({
          turnId: event.turnId,
          status: 'running',
          startedAt: event.createdAt,
        });
      case 'turn.completed':
        return this.putTurn({
          turnId: event.turnId,
          status: event.outcome === 'completed' ? 'completed' : event.outcome,
          startedAt: this.turnIndex.get(event.turnId)?.startedAt ?? event.createdAt,
          endedAt: event.createdAt,
          ...(event.message !== undefined ? { message: event.message } : {}),
        });
      case 'content.delta':
        return this.appendAssistant(event.turnId, event.itemId, event.delta, event.createdAt);
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        // Assistant text already has an entry of its own, streamed through
        // `content.delta`. Repeating it as an activity row would draw every
        // reply twice.
        if (event.item.type === 'assistant_message') {
          return this.finishAssistant(event.item.id, event.type === 'item.completed');
        }
        return this.put({
          kind: 'item',
          id: `item:${event.item.id}`,
          turnId: event.turnId,
          item: {
            type: event.item.type,
            status: event.item.status,
            title: event.item.title,
            ...(event.item.text !== undefined ? { text: event.item.text } : {}),
            ...(event.item.toolName !== undefined ? { toolName: event.item.toolName } : {}),
          },
          createdAt: event.createdAt,
        });
      }
      case 'request.opened':
        return this.put({
          kind: 'request',
          id: event.requestId,
          turnId: event.turnId,
          requestType: event.requestType,
          title: event.title,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          options: event.options,
          state: 'open',
          createdAt: event.createdAt,
        });
      case 'request.resolved': {
        const existing = this.entryIndex.get(event.requestId);
        if (existing?.kind !== 'request') return [];
        return this.put({
          ...existing,
          state: 'resolved',
          decision: event.decision,
        });
      }
      case 'user-input.requested':
        return this.put({
          kind: 'question',
          id: event.requestId,
          turnId: event.turnId,
          questions: event.questions,
          state: 'open',
          createdAt: event.createdAt,
        });
      case 'user-input.resolved': {
        const existing = this.entryIndex.get(event.requestId);
        if (existing?.kind !== 'question') return [];
        return this.put({ ...existing, state: 'resolved' });
      }
      default:
        return [];
    }
  }

  /** Record the answers the console or a room gave, without waiting for the echo. */
  noteAnswers(requestId: string, answers: Record<string, string | string[]>): TranscriptUpdate[] {
    const existing = this.entryIndex.get(requestId);
    if (existing?.kind !== 'question') return [];
    return this.put({ ...existing, answers });
  }

  private setState(state: TranscriptSessionState): TranscriptUpdate[] {
    if (this.state === state) return [];
    this.state = state;
    return [{ type: 'state', state }];
  }

  private putTurn(turn: TranscriptTurn): TranscriptUpdate[] {
    const existing = this.turnIndex.get(turn.turnId);
    if (existing) {
      Object.assign(existing, turn);
      return [{ type: 'turn', turn: { ...existing } }];
    }
    this.turnIndex.set(turn.turnId, turn);
    this.turns.push(turn);
    return [{ type: 'turn', turn: { ...turn } }];
  }

  /**
   * Assistant text streams in as deltas against a provider item id, so the
   * first delta opens the entry and every later one appends to it. The renderer
   * gets an `entry` once and `delta`s thereafter, which is what lets it append
   * to a node instead of re-rendering the whole reply on every token.
   */
  private appendAssistant(
    turnId: string,
    itemId: string,
    delta: string,
    createdAt: string
  ): TranscriptUpdate[] {
    const entryId = this.assistantEntries.get(itemId);
    if (entryId === undefined) {
      const id = `assistant:${itemId}`;
      this.assistantEntries.set(itemId, id);
      return this.put({
        kind: 'assistant',
        id,
        turnId,
        text: delta,
        streaming: true,
        createdAt,
      });
    }
    const entry = this.entryIndex.get(entryId);
    if (entry?.kind !== 'assistant') return [];
    entry.text += delta;
    return [{ type: 'delta', entryId, delta }];
  }

  private finishAssistant(itemId: string, completed: boolean): TranscriptUpdate[] {
    if (!completed) return [];
    const entryId = this.assistantEntries.get(itemId);
    if (entryId === undefined) return [];
    const entry = this.entryIndex.get(entryId);
    if (entry?.kind !== 'assistant' || !entry.streaming) return [];
    entry.streaming = false;
    return [{ type: 'entry', entry: { ...entry } }];
  }

  /** Insert or replace an entry by id, and report it as one `entry` update. */
  private put(entry: TranscriptEntry): TranscriptUpdate[] {
    const existing = this.entryIndex.get(entry.id);
    if (existing) {
      const at = this.entries.indexOf(existing);
      this.entries[at] = entry;
      this.entryIndex.set(entry.id, entry);
      return [{ type: 'entry', entry }];
    }
    this.entries.push(entry);
    this.entryIndex.set(entry.id, entry);
    return [{ type: 'entry', entry }, ...this.trim()];
  }

  /**
   * Drop the oldest entries once past the cap, and say so — once. A transcript
   * that silently loses its beginning reads as one that never had one.
   */
  private trim(): TranscriptUpdate[] {
    if (this.entries.length <= MAX_ENTRIES) return [];
    // Skip the notice itself once it is there: it sits at the front, which is
    // exactly where trimming eats, and a transcript that quietly drops its own
    // "earlier entries were dropped" line is back to lying about its start.
    const from = this.trimmed ? 1 : 0;
    const dropped = this.entries.splice(from, this.entries.length - MAX_ENTRIES);
    for (const entry of dropped) this.entryIndex.delete(entry.id);
    if (this.trimmed) return [];
    this.trimmed = true;
    const notice: TranscriptEntry = {
      kind: 'notice',
      id: TRIM_NOTICE_ID,
      level: 'info',
      text: `This transcript is capped at ${MAX_ENTRIES} entries; earlier ones have been dropped.`,
      createdAt: new Date().toISOString(),
    };
    this.entries.unshift(notice);
    this.entryIndex.set(notice.id, notice);
    return [{ type: 'entry', entry: notice }];
  }
}
