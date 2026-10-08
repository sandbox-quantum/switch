import { z } from 'zod';
import type { ItemType, ProviderRuntimeEvent } from '../events';

/**
 * What each recent tool call was given and what it gave back, held in memory
 * by the session host beside the reasoning buffer and under the same rules.
 *
 * A session-v1 tool item carries only a title: raw tool input and output are
 * not a shared summary, so they are never published, journaled, snapshotted
 * or sent to Switch (whose renderers show an item's text in Slack and the
 * like). A Console on the same machine, or over SSH, reads them here to show
 * what a tool did. Every value is clipped as it is taken, so the buffer and an
 * answer stay bounded however large a file read or a command's output is.
 */

/** How many turns are kept; the oldest go first. */
export const TOOL_DETAIL_TURN_LIMIT = 50;
/** How many tool calls one turn keeps; the oldest go first. */
const TOOL_ITEM_LIMIT = 200;
/** One string inside a tool's input, in UTF-16 code units. */
export const TOOL_INPUT_STRING_LIMIT = 3000;
/** A tool's whole input once serialized; past it the input is kept as clipped text. */
export const TOOL_INPUT_LIMIT = 12 * 1024;
/** A tool's output: its head and its tail are kept, the middle dropped. */
export const TOOL_OUTPUT_HEAD = 6 * 1024;
export const TOOL_OUTPUT_TAIL = 2 * 1024;
/** Roughly how much one answer carries; older turns are left out past it. */
export const TOOL_ANSWER_LIMIT = 1024 * 1024;

const TOOL_TYPES: ReadonlySet<ItemType> = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'tool_call',
  'web_search',
  'subagent',
]);

export const hostToolDetailSchema = z.object({
  /** The session-v1 item id the call was projected under. */
  itemId: z.string().min(1),
  type: z.string(),
  toolName: z.string().nullable(),
  /** The call's arguments, with long strings clipped; null when it had none. */
  input: z.unknown(),
  output: z.string().nullable(),
  /** Whether anything above was clipped. */
  truncated: z.boolean(),
  exitCode: z.number().nullable(),
});
export type HostToolDetail = z.infer<typeof hostToolDetailSchema>;

export const hostToolTurnSchema = z.object({
  turnId: z.string().min(1),
  tools: z.array(hostToolDetailSchema),
});
export type HostToolTurn = z.infer<typeof hostToolTurnSchema>;

type ToolEntry = {
  itemId: string;
  type: ItemType;
  toolName: string | null;
  input: unknown;
  inputClipped: boolean;
  head: string;
  tail: string;
  outputClipped: boolean;
  hasOutput: boolean;
  exitCode: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The arguments in a provider payload: OpenCode nests them under `input`. */
function payloadInput(payload: Record<string, unknown> | undefined): unknown {
  if (!payload) return null;
  if (typeof payload.tool === 'string' && isRecord(payload.input)) return payload.input;
  return payload;
}

function clipValue(value: unknown, depth: number, clipped: { value: boolean }): unknown {
  if (typeof value === 'string') {
    if (value.length <= TOOL_INPUT_STRING_LIMIT) return value;
    clipped.value = true;
    return `${value.slice(0, TOOL_INPUT_STRING_LIMIT)}…`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) {
    clipped.value = true;
    return '…';
  }
  if (Array.isArray(value)) {
    if (value.length > 100) clipped.value = true;
    return value.slice(0, 100).map((each) => clipValue(each, depth + 1, clipped));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [key, clipValue(each, depth + 1, clipped)])
  );
}

function clipInput(payload: Record<string, unknown> | undefined): {
  input: unknown;
  clipped: boolean;
} {
  const clipped = { value: false };
  const input = clipValue(payloadInput(payload), 0, clipped);
  const text = JSON.stringify(input) ?? '';
  if (text.length <= TOOL_INPUT_LIMIT) return { input, clipped: clipped.value };
  return { input: `${text.slice(0, TOOL_INPUT_LIMIT)}…`, clipped: true };
}

function exitCodeOf(payload: Record<string, unknown> | undefined): number | null {
  const code = payload?.exitCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

function setOutput(entry: ToolEntry, text: string): void {
  entry.head = '';
  entry.tail = '';
  entry.outputClipped = false;
  appendOutput(entry, text);
}

function appendOutput(entry: ToolEntry, text: string): void {
  entry.hasOutput = true;
  const room = TOOL_OUTPUT_HEAD - entry.head.length;
  if (room > 0) {
    entry.head += text.slice(0, room);
    text = text.slice(room);
  }
  if (text.length === 0) return;
  const tail = entry.tail + text;
  if (tail.length > TOOL_OUTPUT_TAIL) entry.outputClipped = true;
  entry.tail = tail.slice(-TOOL_OUTPUT_TAIL);
}

function detailOf(entry: ToolEntry): HostToolDetail {
  return {
    itemId: entry.itemId,
    type: entry.type,
    toolName: entry.toolName,
    input: entry.input,
    output: entry.hasOutput
      ? entry.outputClipped
        ? `${entry.head}\n…\n${entry.tail}`
        : entry.head + entry.tail
      : null,
    truncated: entry.inputClipped || entry.outputClipped,
    exitCode: entry.exitCode,
  };
}

function sizeOf(detail: HostToolDetail): number {
  return (JSON.stringify(detail.input) ?? '').length + (detail.output?.length ?? 0) + 200;
}

export class ToolDetailBuffer {
  private epoch: string | null = null;
  /** In insertion order, so the first entry is the oldest turn. */
  private readonly turns = new Map<string, Map<string, ToolEntry>>();

  /** Take one provider event, for the session's current epoch. Ignores all but tool calls. */
  ingest(event: ProviderRuntimeEvent, epoch: string): void {
    if (this.epoch !== epoch) {
      this.turns.clear();
      this.epoch = epoch;
    }
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (!TOOL_TYPES.has(item.type)) return;
        const tools = this.turn(event.turnId);
        let entry = tools.get(item.id);
        if (!entry) {
          entry = {
            itemId: JSON.stringify([event.turnId, item.id]),
            type: item.type,
            toolName: null,
            input: null,
            inputClipped: false,
            head: '',
            tail: '',
            outputClipped: false,
            hasOutput: false,
            exitCode: null,
          };
          tools.set(item.id, entry);
          while (tools.size > TOOL_ITEM_LIMIT) {
            const oldest = tools.keys().next().value;
            if (oldest === undefined) break;
            tools.delete(oldest);
          }
        }
        entry.type = item.type;
        if (item.toolName) entry.toolName = item.toolName;
        if (item.payload) {
          const { input, clipped } = clipInput(item.payload);
          entry.input = input;
          entry.inputClipped = clipped;
          entry.exitCode = exitCodeOf(item.payload) ?? entry.exitCode;
        }
        if (item.text !== undefined && item.text.length > 0) setOutput(entry, item.text);
        return;
      }
      case 'item.delta': {
        const entry = this.turns.get(event.turnId)?.get(event.itemId);
        if (entry && event.delta.length > 0) appendOutput(entry, event.delta);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The calls held for `turnIds` (every turn when null), oldest turn first.
   * Turns are taken newest first until the answer reaches its limit, so a
   * request for many large turns leaves the oldest of them out rather than
   * growing without bound.
   */
  list(epoch: string, turnIds: string[] | null): HostToolTurn[] {
    if (this.epoch !== epoch) return [];
    const wanted = turnIds === null ? null : new Set(turnIds);
    const picked: HostToolTurn[] = [];
    let size = 0;
    for (const [turnId, tools] of [...this.turns].reverse()) {
      if (wanted && !wanted.has(turnId)) continue;
      if (size >= TOOL_ANSWER_LIMIT) break;
      const details = [...tools.values()].map((entry) => {
        const detail = detailOf(entry);
        size += sizeOf(detail);
        // Past the limit a call is still listed, so its row can say what it was, but bare.
        return size > TOOL_ANSWER_LIMIT
          ? { ...detail, input: null, output: null, truncated: true }
          : detail;
      });
      picked.push({ turnId, tools: details });
    }
    return picked.reverse();
  }

  private turn(turnId: string): Map<string, ToolEntry> {
    let tools = this.turns.get(turnId);
    if (!tools) {
      tools = new Map();
      this.turns.set(turnId, tools);
      while (this.turns.size > TOOL_DETAIL_TURN_LIMIT) {
        const oldest = this.turns.keys().next().value;
        if (oldest === undefined) break;
        this.turns.delete(oldest);
      }
    }
    return tools;
  }
}
