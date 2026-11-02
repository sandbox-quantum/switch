import { join } from 'node:path';
import type { Origin, ServerEvent } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { TokenUsage } from '../events';
import { Journal } from './journal';

/**
 * What Switch shows of a session on messaging platforms, derived from the
 * session's own event journal: one row per turn step (the turn itself, each
 * message and tool call, each notice), and the requests a person can answer
 * there.
 *
 * Rows are keyed by turn and item and carry a revision, so replaying the
 * journal sends rows Switch already holds and it keeps the newest of each.
 */
const MAX_TITLE = 500;
const MAX_TEXT = 8000;
const MAX_DETAIL = 4000;
const MAX_LABEL = 200;

export type ActivityRow = {
  turn_id: string;
  item_id: string;
  kind: 'turn' | 'user-message' | 'assistant-message' | 'tool-activity' | 'notice';
  revision: number;
  status: string;
  title: string;
  text: string;
  command_id: string | null;
  room_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  occurred_at: string;
  /**
   * What the turn spent, on its own row once it has ended. Left out when
   * there is nothing to say, so a server that predates it takes the row.
   */
  usage?: UsageRow[];
};

export type UsageRow = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type RequestOpening = {
  request_id: string;
  turn_id: string;
  kind: 'approval' | 'questions';
  title: string;
  detail: string | null;
  options: { id: string; label: string; decision: string }[];
  questions: {
    id: string;
    title: string;
    prompt: string;
    options: { id: string; label: string; description: string | null }[];
    multi_select: boolean;
    allow_custom_answer: boolean;
  }[];
  room_id: string | null;
  thread_id: string | null;
  expires_at: string | null;
};

export type Report =
  | { kind: 'activity'; row: ActivityRow }
  | { kind: 'approval.open'; body: RequestOpening }
  | { kind: 'approval.close'; requestId: string };

type Placement = Pick<ActivityRow, 'room_id' | 'thread_id' | 'message_id'>;

const ENDED = new Set(['completed', 'interrupted', 'error']);

const cursorSchema = z.strictObject({ through: z.number().int().nonnegative() });

export class ActivityReporter {
  private runningTurn: string | null = null;
  private endedTurn: { turnId: string; sequence: number } | null = null;

  private constructor(private readonly journal: Journal<z.infer<typeof cursorSchema>>) {}

  static async load(root: string): Promise<ActivityReporter> {
    return new ActivityReporter(
      await Journal.load(join(root, 'activity-reported.jsonl'), (input) =>
        cursorSchema.parse(input)
      )
    );
  }

  /** Whether this session has never reported here before. */
  get fresh(): boolean {
    return this.journal.records.length === 0;
  }

  /** The last journal event whose reports Switch has acknowledged. */
  get cursor(): number {
    return this.journal.records.at(-1)?.through ?? 0;
  }

  async advance(through: number): Promise<void> {
    if (through > this.cursor) await this.journal.append({ through });
  }

  /**
   * Follow events already reported, without reporting them again, so a notice
   * after a restart still knows which turn it belongs to.
   */
  catchUp(events: ServerEvent[]): void {
    for (const event of events) this.track(event);
  }

  reports(
    event: ServerEvent,
    originOf: (turnId: string) => Origin | null,
    usageOf: (turnId: string) => TokenUsage[]
  ): Report[] {
    const body = event.body;
    const place = (turnId: string): Placement => {
      const origin = originOf(turnId);
      return {
        room_id: origin?.roomId ?? null,
        thread_id: origin ? (origin.threadId ?? origin.messageId) : null,
        message_id: origin?.messageId ?? null,
      };
    };
    const noticeTurn = body.type === 'notice' ? this.noticeTurn(event.sequence) : null;
    this.track(event);
    switch (body.type) {
      case 'turn.upsert': {
        const usage = ENDED.has(body.status) ? usageOf(body.turnId) : [];
        return [
          {
            kind: 'activity',
            row: {
              turn_id: body.turnId,
              item_id: 'turn',
              kind: 'turn',
              revision: event.sequence,
              status: body.status,
              title: '',
              text: '',
              command_id: body.commandId,
              ...place(body.turnId),
              occurred_at: event.occurredAt,
              ...(usage.length > 0 ? { usage: usage.map(usageRow) } : {}),
            },
          },
        ];
      }
      case 'item.upsert': {
        const { item } = body;
        return [
          {
            kind: 'activity',
            row: {
              turn_id: item.turnId,
              item_id: item.itemId,
              kind: item.kind,
              revision: item.revision,
              status: item.status,
              title: truncate(item.title, MAX_TITLE),
              text: truncate(item.text, MAX_TEXT),
              command_id: null,
              ...place(item.turnId),
              occurred_at: event.occurredAt,
            },
          },
        ];
      }
      case 'notice': {
        // A notice outside any turn (a model change, a room delivery problem)
        // has no turn to be drawn in on a platform.
        if (noticeTurn === null) return [];
        return [
          {
            kind: 'activity',
            row: {
              turn_id: noticeTurn,
              item_id: `notice:${event.sequence}`,
              kind: 'notice',
              revision: 0,
              status: body.level,
              title: truncate(body.message, MAX_TITLE),
              text: truncate(body.message, MAX_TEXT),
              command_id: null,
              ...place(noticeTurn),
              occurred_at: event.occurredAt,
            },
          },
        ];
      }
      case 'request.opened': {
        const { request } = body;
        const { content } = request;
        const { room_id, thread_id } = place(request.turnId);
        return [
          {
            kind: 'approval.open',
            body: {
              request_id: request.requestId,
              turn_id: request.turnId,
              kind: content.kind,
              title: truncate(content.title, MAX_TITLE),
              detail:
                content.kind === 'approval' && content.detail !== null
                  ? truncate(content.detail, MAX_DETAIL)
                  : null,
              options:
                content.kind === 'approval'
                  ? content.options.map((option) => ({
                      id: option.optionId,
                      label: truncate(option.label, MAX_LABEL),
                      decision: option.decision,
                    }))
                  : [],
              questions:
                content.kind === 'questions'
                  ? content.questions.map((question) => ({
                      id: question.questionId,
                      title: question.title,
                      prompt: question.prompt,
                      options: question.options.map((option) => ({
                        id: option.optionId,
                        label: option.label,
                        description: option.description,
                      })),
                      multi_select: question.multiSelect,
                      allow_custom_answer: question.allowCustomAnswer,
                    }))
                  : [],
              room_id,
              thread_id,
              expires_at: request.expiresAt,
            },
          },
        ];
      }
      case 'request.settled':
        return [{ kind: 'approval.close', requestId: body.requestId }];
      default:
        return [];
    }
  }

  /**
   * The running turn, or else the turn that ended on the event just before:
   * a turn that fails before it runs says why right after it ends.
   */
  private noticeTurn(sequence: number): string | null {
    if (this.runningTurn !== null) return this.runningTurn;
    if (this.endedTurn !== null && this.endedTurn.sequence === sequence - 1)
      return this.endedTurn.turnId;
    return null;
  }

  private track(event: ServerEvent): void {
    const body = event.body;
    if (body.type !== 'turn.upsert') return;
    if (body.status === 'running') {
      this.runningTurn = body.turnId;
      return;
    }
    if (body.status === 'queued') return;
    if (this.runningTurn === body.turnId) this.runningTurn = null;
    this.endedTurn = { turnId: body.turnId, sequence: event.sequence };
  }
}

function usageRow(usage: TokenUsage): UsageRow {
  return {
    model: usage.model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
  };
}

function truncate(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join('')}…`;
}
