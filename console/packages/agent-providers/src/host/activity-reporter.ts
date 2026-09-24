import { join } from 'node:path';
import type { Origin, ServerEvent } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { Journal } from './journal';

/**
 * What Switch shows of a session on messaging platforms, derived from the
 * session's own event journal: short activity lines, and the approval requests
 * a person can answer there.
 *
 * Every line is numbered from the journal event it came from
 * (`sequence * LINES_PER_EVENT + index`), so replaying the journal yields the
 * same numbers and Switch records each line once however often it is sent.
 */
export const LINES_PER_EVENT = 2;
const MAX_SUMMARY = 2000;
const MAX_QUESTION = 4000;
const MAX_LABEL = 200;

export type ActivityLine = {
  seq: number;
  type: 'turn.started' | 'tool.called' | 'tool.finished' | 'turn.finished' | 'notice';
  summary: string;
  detail: Record<string, unknown>;
  turn_id: string | null;
  room_id: string | null;
  thread_id: string | null;
  occurred_at: string;
};

export type ApprovalOpening = {
  request_id: string;
  question: string;
  options: { id: string; label: string; decision: string }[];
  room_id: string | null;
  thread_id: string | null;
  expires_at: string | null;
};

export type Report =
  | { kind: 'activity'; line: ActivityLine }
  | { kind: 'approval.open'; body: ApprovalOpening }
  | { kind: 'approval.close'; requestId: string };

const TURN_ENDINGS: Record<string, string> = {
  completed: 'Finished',
  interrupted: 'Interrupted',
  error: 'Stopped with an error',
};

const cursorSchema = z.strictObject({ through: z.number().int().nonnegative() });

export class ActivityReporter {
  private readonly finishedTools = new Set<string>();
  private runningTurn: string | null = null;

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

  reports(event: ServerEvent, originOf: (turnId: string) => Origin | null): Report[] {
    const body = event.body;
    const line = (
      index: number,
      type: ActivityLine['type'],
      summary: string,
      detail: Record<string, unknown>,
      turnId: string | null
    ): Report => {
      const origin = turnId === null ? null : originOf(turnId);
      return {
        kind: 'activity',
        line: {
          seq: event.sequence * LINES_PER_EVENT + index,
          type,
          summary: fit(summary, MAX_SUMMARY),
          detail,
          turn_id: turnId,
          room_id: origin?.roomId ?? null,
          thread_id: origin ? (origin.threadId ?? origin.messageId) : null,
          occurred_at: event.occurredAt,
        },
      };
    };
    switch (body.type) {
      case 'turn.upsert': {
        if (body.status === 'running') {
          this.runningTurn = body.turnId;
          return [line(0, 'turn.started', 'Started working', {}, body.turnId)];
        }
        const ending = TURN_ENDINGS[body.status];
        if (!ending) return [];
        if (this.runningTurn === body.turnId) this.runningTurn = null;
        return [line(0, 'turn.finished', ending, { status: body.status }, body.turnId)];
      }
      case 'item.upsert': {
        const { item } = body;
        if (item.kind !== 'tool-activity' || item.itemId.includes(':part:')) return [];
        const title = item.title.trim() || 'Used a tool';
        const reports: Report[] = [];
        if (item.revision === 1)
          reports.push(line(0, 'tool.called', title, { item_id: item.itemId }, item.turnId));
        if (item.status !== 'in-progress' && !this.finishedTools.has(item.itemId)) {
          this.finishedTools.add(item.itemId);
          const summary = item.status === 'completed' ? title : `${title} (${item.status})`;
          reports.push(
            line(
              1,
              'tool.finished',
              summary,
              { item_id: item.itemId, status: item.status },
              item.turnId
            )
          );
        }
        return reports;
      }
      case 'notice': {
        const message = body.message.trim();
        if (!message) return [];
        return [
          line(0, 'notice', message, { level: body.level, code: body.code }, this.runningTurn),
        ];
      }
      case 'request.opened': {
        const { request } = body;
        if (request.content.kind !== 'approval') return [];
        const origin = originOf(request.turnId);
        const { title, detail, options } = request.content;
        return [
          {
            kind: 'approval.open',
            body: {
              request_id: request.requestId,
              question: fit(detail ? `${title}\n\n${detail}` : title, MAX_QUESTION),
              options: options.map((option) => ({
                id: option.optionId,
                label: fit(option.label, MAX_LABEL),
                decision: option.decision,
              })),
              room_id: origin?.roomId ?? null,
              thread_id: origin ? (origin.threadId ?? origin.messageId) : null,
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
}

function fit(text: string, limit: number): string {
  const trimmed = text.trim() || '(empty)';
  const characters = Array.from(trimmed);
  return characters.length <= limit ? trimmed : `${characters.slice(0, limit - 1).join('')}…`;
}
