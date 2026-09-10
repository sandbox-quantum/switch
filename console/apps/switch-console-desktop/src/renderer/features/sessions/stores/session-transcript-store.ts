import type { UserInputAnswers } from '@switch-console/agent-providers';
import type { ApprovalDecision } from '@switch-console/agent-providers';
import type { IDisposable } from '@switch-console/shared';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { transcriptRpc } from '@renderer/features/sessions/stores/session-transcript-rpc';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { events } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import {
  sessionTranscriptChannel,
  type SessionTranscript,
  type TranscriptEntry,
  type TranscriptSessionState,
  type TranscriptTurn,
  type TranscriptUpdate,
} from '@shared/core/sessions/session-transcript';

/** A `request` or `question` entry still waiting on a person. */
export type PendingInput = Extract<TranscriptEntry, { kind: 'request' | 'question' }>;

/** An `item` entry — one line of agent activity. */
export type ActivityEntry = Extract<TranscriptEntry, { kind: 'item' }>;

/**
 * Renderer-side transcript for one provider-backed session.
 *
 * The main process owns the transcript; this mirrors it. The snapshot arrives
 * once over `sessionTranscript.get`, and every later change over the
 * `session:transcript` channel, topic'd on the session id. The subscription is
 * opened *before* the snapshot is asked for and updates that land while it is
 * in flight are buffered, so nothing is lost in the gap between the two.
 *
 * One instance per session, held in the session-transcript registry.
 */
export class SessionTranscriptStore implements IDisposable {
  /** Entry id → entry. Deeply observable, so a delta re-renders one message. */
  private readonly entriesById = observable.map<string, TranscriptEntry>();
  /** Entry ids in arrival order; the transcript's reading order. */
  private readonly order = observable.array<string>([]);

  state: TranscriptSessionState = 'starting';
  turns: TranscriptTurn[] = [];
  /** True until the first snapshot lands (or fails). */
  loading = true;
  /** Set when the snapshot could not be read; the panel says so rather than showing an empty transcript. */
  error: string | null = null;

  private readonly offTranscript: () => void;
  private buffered: TranscriptUpdate[] | null = [];
  private disposed = false;

  constructor(private readonly sessionId: string) {
    makeObservable<
      SessionTranscriptStore,
      'entriesById' | 'order' | 'upsertEntry' | 'upsertTurn' | 'replace'
    >(this, {
      entriesById: observable,
      order: observable,
      state: observable,
      turns: observable,
      loading: observable,
      error: observable,
      entries: computed,
      pendingInputs: computed,
      isRunning: computed,
      canSend: computed,
      applyUpdate: action,
      upsertEntry: action,
      upsertTurn: action,
      replace: action,
    });

    this.offTranscript = events.on(
      sessionTranscriptChannel,
      (payload) => {
        if (payload.sessionId !== this.sessionId) return;
        if (this.buffered) {
          this.buffered.push(payload.update);
          return;
        }
        this.applyUpdate(payload.update);
      },
      this.sessionId
    );

    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const transcript = await transcriptRpc().get({ sessionId: this.sessionId });
      if (this.disposed) return;
      runInAction(() => {
        this.replace(transcript);
        this.error = null;
      });
    } catch (error) {
      if (this.disposed) return;
      log.error('SessionTranscriptStore: failed to read transcript', {
        sessionId: this.sessionId,
        error,
      });
      runInAction(() => {
        this.error = failureText(error, 'Could not read the transcript.');
      });
    } finally {
      if (!this.disposed) {
        runInAction(() => {
          const queued = this.buffered ?? [];
          this.buffered = null;
          for (const update of queued) this.applyUpdate(update);
          this.loading = false;
        });
      }
    }
  }

  // --- Reading -------------------------------------------------------------

  /** Every entry, in arrival order. */
  get entries(): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const id of this.order) {
      const entry = this.entriesById.get(id);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Approvals and questions still waiting on a person, derived rather than read
   * from the snapshot's `pendingInputIds`: an entry resolving is an entry
   * update, so deriving cannot fall out of step with what is on screen.
   */
  get pendingInputs(): PendingInput[] {
    return this.entries.filter(
      (entry): entry is PendingInput =>
        (entry.kind === 'request' || entry.kind === 'question') && entry.state === 'open'
    );
  }

  /** True while any turn is still running. */
  get isRunning(): boolean {
    return this.turns.some((turn) => turn.status === 'running');
  }

  /** The composer is live once the session is past startup and not finished with. */
  get canSend(): boolean {
    return this.state === 'ready' || this.state === 'running';
  }

  turn(turnId: string): TranscriptTurn | undefined {
    return this.turns.find((turn) => turn.turnId === turnId);
  }

  // --- Applying updates ----------------------------------------------------

  applyUpdate(update: TranscriptUpdate): void {
    switch (update.type) {
      case 'state':
        this.state = update.state;
        return;
      case 'entry':
        this.upsertEntry(update.entry);
        return;
      case 'delta': {
        const entry = this.entriesById.get(update.entryId);
        if (!entry) {
          log.warn('SessionTranscriptStore: delta for an unknown entry', {
            sessionId: this.sessionId,
            entryId: update.entryId,
          });
          return;
        }
        if (entry.kind !== 'assistant') {
          log.warn('SessionTranscriptStore: delta for a non-assistant entry', {
            sessionId: this.sessionId,
            entryId: update.entryId,
            kind: entry.kind,
          });
          return;
        }
        entry.text += update.delta;
        return;
      }
      case 'turn':
        this.upsertTurn(update.turn);
        return;
      case 'reset':
        this.replace(update.transcript);
        return;
    }
  }

  private upsertEntry(entry: TranscriptEntry): void {
    if (!this.entriesById.has(entry.id)) this.order.push(entry.id);
    this.entriesById.set(entry.id, entry);
  }

  private upsertTurn(turn: TranscriptTurn): void {
    const index = this.turns.findIndex((existing) => existing.turnId === turn.turnId);
    if (index === -1) {
      this.turns.push(turn);
      return;
    }
    this.turns[index] = turn;
  }

  private replace(transcript: SessionTranscript): void {
    this.entriesById.clear();
    this.order.replace([]);
    for (const entry of transcript.entries) this.upsertEntry(entry);
    this.turns = [...transcript.turns];
    this.state = transcript.state;
  }

  // --- Writing -------------------------------------------------------------

  async sendTurn(text: string): Promise<void> {
    await transcriptRpc().sendTurn({ sessionId: this.sessionId, text });
  }

  async interrupt(): Promise<void> {
    await transcriptRpc().interrupt({ sessionId: this.sessionId });
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    await transcriptRpc().respondToRequest({ sessionId: this.sessionId, requestId, decision });
  }

  async respondToUserInput(requestId: string, answers: UserInputAnswers): Promise<void> {
    await transcriptRpc().respondToUserInput({ sessionId: this.sessionId, requestId, answers });
  }

  dispose(): void {
    this.disposed = true;
    this.offTranscript();
  }
}
