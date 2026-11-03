import type {
  ItemStatus,
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  TokenUsage,
  TurnOutcome,
} from '../events';
import { mergeUsage } from '../usage';
import { PI_COMMAND_TOOL, PI_FILE_CHANGE_TOOLS, PI_MCP_RESOURCE_TOOLS } from './pi-policy';
import type { PiRpcEvent } from './pi-rpc';

/**
 * Maps the events of one Pi run (`pi --mode rpc`, Pi 1.4.0) to Switch's events for one turn
 * (READY §2.5). The adapter makes one mapper per turn, feeds it the events of the process in
 * order once it has bound the run the bridge announced to that turn (ER-02), together with those
 * it held from the `prompt` until then (a compaction before the run, below), and emits what comes
 * back after filling in `eventId`, `provider`, `sessionId` and `createdAt`.
 *
 * The turn ends on `agent_settled` and only there (READY §2.5; `spike-pi.md` N5): Pi writes an
 * `agent_end` for every attempt, also those it then retries (`agent_end.willRetry`,
 * `core/agent-session.js:753`; recorded `evidence/spike/r2-4-retry/rpc-run2.jsonl`: four
 * `agent_end`, one `agent_settled`), and the host frees its queue on `turn.completed`, so an end
 * taken from `agent_end` would let the next turn race this one. The ends that never reach
 * `agent_settled` (a `prompt` answered `handled` or with an error, a failure before the run, the
 * process exiting; ER-02) are the adapter's to see; it ends the turn with {@link finish}. Either
 * way there is exactly one `turn.completed`: after it the mapper returns nothing.
 *
 * Items:
 * - `bash` → `command_execution`, `edit`/`write` → `file_change`, MCP tools (`mcp__…` and the
 *   resource tools) → `mcp_tool_call`, the rest → `tool_call` (READY §2.5; `AP/events.ts:20-30`),
 *   from `tool_execution_start` / `_update` / `_end` keyed by `toolCallId`;
 * - a call the adapter refused (a declined card, a cancelled or out-of-turn request) ends
 *   `declined` (`AP/events.ts:32`): Pi reports it as a failed call (`tool_execution_end` with
 *   `isError`, recorded `evidence/spike/r2-1-gate/rpc-run1.jsonl:27`), so the adapter says which
 *   ones it refused with {@link markDeclined};
 * - assistant text → `assistant_message` with `content.delta`, thinking → `reasoning` with
 *   `item.delta`, from `message_update.assistantMessageEvent` (`pi-ai` `types.d.ts:575-630`);
 *   a message that ends in error closes them `failed`;
 * - compaction during the run → `context_compaction`.
 *
 * Usage (`AP/events.ts:107-115`): every assistant `message_end` of the run adds its `usage`
 * under its `model`, a compaction adds its own under the model of the run (the last assistant
 * message's, else the session's model the adapter passes, {@link PiTurnMapperOptions.model});
 * failed attempts count what they report. Nothing reported → `[]`.
 *
 * Pi can compact before the run starts (`core/agent-session.js:1480-1488`): those events come
 * after the `prompt` command and before its response and `agent_start` (recorded
 * `r2-4-retry/rpc-run2.full.jsonl:104-107`). They belong to this turn: the adapter feeds them too,
 * holding them until the run is bound and dropping them when it is not this turn's.
 *
 * Outcome: `agent_settled.aborted` → `interrupted`; Pi gave up recovering the last response by
 * compaction → `error` with Pi's message ({@link compactionEnd}); a last assistant message that
 * ended in `error` → `error` with its `errorMessage` (retries that run out end that way too: Pi's
 * `auto_retry_end` with `success: false` repeats that message, `core/agent-session.js:1550-1556`);
 * otherwise `completed`.
 */

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

/** A Switch event for the adapter to emit, without the fields the adapter fills in. */
export type PiTurnEvent = Emittable;

const TITLE_LIMIT = 200;
const OUTPUT_LIMIT = 64 * 1024;

interface OpenBlock {
  itemId: string;
  type: 'assistant_message' | 'reasoning';
  text: string;
}

export interface PiTurnMapperOptions {
  turnId: string;
  /**
   * The id of the session's model as Pi confirmed it: the `set_model` response's `data.id` or
   * `get_state`'s `model.id` (Pi 1.4.0 `modes/rpc/rpc-mode.js:345-373`). Pi compacts with that
   * model (`core/agent-session.js:2522`), also before the run starts (`:1480-1488`), when no
   * assistant message of the turn has named one yet; a later assistant message's `model` takes
   * over. Without it such usage counts under `''`.
   */
  model?: string;
}

export class PiTurnMapper {
  readonly turnId: string;
  private done = false;
  private readonly declined = new Set<string>();
  private readonly tools = new Map<string, ProviderItem>();
  private blocks = new Map<number, OpenBlock>();
  /** Content indices of the current message that were streamed (have or had a block). */
  private streamed = new Set<number>();
  private messageCount = 0;
  private compactionCount = 0;
  private openCompaction: ProviderItem | null = null;
  private usage: TokenUsage[] = [];
  private model: string;
  private lastAssistantError: string | undefined;
  /** `stopReason` of the turn's last assistant message; undefined before the first one. */
  private lastAssistantStop: string | undefined;
  /** Pi gave up recovering the turn's last response by compaction (see {@link compactionEnd}). */
  private recoveryError: string | undefined;

  constructor(options: PiTurnMapperOptions) {
    this.turnId = options.turnId;
    this.model = options.model ?? '';
  }

  /** Whether the turn has ended; nothing more is mapped. */
  get completed(): boolean {
    return this.done;
  }

  /** The adapter refused this tool call: its item ends `declined`, whatever Pi reports. */
  markDeclined(toolCallId: string): void {
    this.declined.add(toolCallId);
  }

  /** Maps one event of the process; events that are not about the turn give nothing. */
  handle(event: PiRpcEvent): PiTurnEvent[] {
    if (this.done) return [];
    switch (event.type) {
      case 'message_start':
        return this.messageStart(event);
      case 'message_update':
        return this.messageUpdate(event);
      case 'message_end':
        return this.messageEnd(event);
      case 'tool_execution_start':
        return this.toolStart(event);
      case 'tool_execution_update':
        return this.toolUpdate(event);
      case 'tool_execution_end':
        return this.toolEnd(event);
      case 'compaction_start':
        return this.compactionStart(event);
      case 'compaction_end':
        return this.compactionEnd(event);
      case 'auto_retry_start':
        return this.retryStart(event);
      case 'agent_settled': {
        let outcome: TurnOutcome = 'completed';
        let message: string | undefined;
        if (event.aborted === true) outcome = 'interrupted';
        else if (this.recoveryError !== undefined) {
          outcome = 'error';
          message = this.recoveryError;
        } else if (this.lastAssistantError !== undefined) {
          outcome = 'error';
          message = this.lastAssistantError;
        }
        return this.finish(outcome, message);
      }
      default:
        // `agent_start`, `agent_end` (also with `willRetry`), `turn_start`, `turn_end`,
        // `auto_retry_end` (when it says `success: false` the last assistant message is the error
        // it gives up on, `core/agent-session.js:1550-1556`), `extension_ui_request` (the
        // adapter's), `entry_appended`, and anything newer.
        return [];
    }
  }

  /**
   * Ends the turn now, once: items still open are closed `failed`, and `turn.completed` carries
   * the usage seen so far. For the ends that never reach `agent_settled` (ER-02) and for a stop
   * the adapter had to force. Returns nothing when the turn has already ended.
   */
  finish(outcome: TurnOutcome, message?: string): PiTurnEvent[] {
    if (this.done) return [];
    this.done = true;
    const out: PiTurnEvent[] = [];
    for (const block of this.blocks.values()) out.push(this.closeBlock(block, 'failed'));
    this.blocks.clear();
    for (const [toolCallId, item] of this.tools) {
      const status: ItemStatus = this.declined.has(toolCallId) ? 'declined' : 'failed';
      out.push({ type: 'item.completed', turnId: this.turnId, item: { ...item, status } });
    }
    this.tools.clear();
    if (this.openCompaction) {
      out.push({
        type: 'item.completed',
        turnId: this.turnId,
        item: { ...this.openCompaction, status: 'failed' },
      });
      this.openCompaction = null;
    }
    out.push({
      type: 'turn.completed',
      turnId: this.turnId,
      outcome,
      ...(message !== undefined ? { message } : {}),
      usage: this.usage.filter(spent),
    });
    return out;
  }

  private messageStart(event: PiRpcEvent): PiTurnEvent[] {
    const message = record(event.message);
    if (message?.role !== 'assistant') return [];
    this.messageCount += 1;
    this.blocks = new Map();
    this.streamed = new Set();
    if (typeof message.model === 'string') this.model = message.model;
    return [];
  }

  private messageUpdate(event: PiRpcEvent): PiTurnEvent[] {
    const update = record(event.assistantMessageEvent);
    if (!update || typeof update.contentIndex !== 'number') return [];
    const index = update.contentIndex;
    switch (update.type) {
      case 'text_start':
      case 'thinking_start': {
        if (this.blocks.has(index)) return [];
        const type = update.type === 'text_start' ? 'assistant_message' : 'reasoning';
        const block: OpenBlock = { itemId: this.blockId(index), type, text: '' };
        this.blocks.set(index, block);
        this.streamed.add(index);
        return [
          {
            type: 'item.started',
            turnId: this.turnId,
            item: {
              id: block.itemId,
              type,
              status: 'in_progress',
              title: type === 'assistant_message' ? 'Assistant message' : 'Reasoning',
            },
          },
        ];
      }
      case 'text_delta':
      case 'thinking_delta': {
        const block = this.blocks.get(index);
        if (!block || typeof update.delta !== 'string' || update.delta === '') return [];
        block.text += update.delta;
        return [
          block.type === 'assistant_message'
            ? {
                type: 'content.delta',
                turnId: this.turnId,
                itemId: block.itemId,
                delta: update.delta,
              }
            : {
                type: 'item.delta',
                turnId: this.turnId,
                itemId: block.itemId,
                delta: update.delta,
              },
        ];
      }
      case 'text_end':
      case 'thinking_end': {
        const block = this.blocks.get(index);
        if (!block) return [];
        if (typeof update.content === 'string') block.text = update.content;
        this.blocks.delete(index);
        return [this.closeBlock(block, 'completed')];
      }
      default:
        return [];
    }
  }

  private messageEnd(event: PiRpcEvent): PiTurnEvent[] {
    const message = record(event.message);
    if (message?.role !== 'assistant') return [];
    const model = typeof message.model === 'string' ? message.model : this.model;
    if (model) this.model = model;
    this.addUsage(model, message.usage);
    const stopReason = message.stopReason;
    this.lastAssistantStop = typeof stopReason === 'string' ? stopReason : undefined;
    this.recoveryError = undefined;
    this.lastAssistantError =
      stopReason === 'error' ? stringOr(message.errorMessage, 'Pi reported an error') : undefined;
    const failed = stopReason === 'error' || stopReason === 'aborted';
    const out: PiTurnEvent[] = [];
    // Blocks still open close with the message; a message that streamed nothing gets its text
    // items here, from the final content.
    const content = Array.isArray(message.content) ? message.content : [];
    for (const [index, block] of this.blocks) {
      const part = record(content[index]);
      if (!failed && part && typeof part.text === 'string') block.text = part.text;
      if (!failed && part && typeof part.thinking === 'string') block.text = part.thinking;
      out.push(this.closeBlock(block, failed ? 'failed' : 'completed'));
    }
    if (!failed) {
      content.forEach((raw, index) => {
        if (this.streamed.has(index)) return;
        const part = record(raw);
        if (part?.type !== 'text' || typeof part.text !== 'string' || part.text === '') return;
        const item: ProviderItem = {
          id: this.blockId(index),
          type: 'assistant_message',
          status: 'completed',
          title: firstLine(part.text, 'Assistant message'),
          text: part.text,
        };
        out.push({
          type: 'item.started',
          turnId: this.turnId,
          item: { ...item, status: 'in_progress' },
        });
        out.push({ type: 'item.completed', turnId: this.turnId, item });
      });
    }
    this.blocks = new Map();
    this.streamed = new Set();
    return out;
  }

  private toolStart(event: PiRpcEvent): PiTurnEvent[] {
    const toolCallId = event.toolCallId;
    const toolName = event.toolName;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return [];
    if (this.tools.has(toolCallId)) return [];
    const args = record(event.args) ?? {};
    const item: ProviderItem = {
      id: toolCallId,
      type: piItemType(toolName),
      status: 'in_progress',
      title: toolTitle(toolName, args),
      ...(isToolShaped(toolName) ? { toolName } : {}),
      payload: { args },
    };
    this.tools.set(toolCallId, item);
    return [{ type: 'item.started', turnId: this.turnId, item }];
  }

  private toolUpdate(event: PiRpcEvent): PiTurnEvent[] {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== 'string') return [];
    const item = this.tools.get(toolCallId);
    if (!item) return [];
    // Pi sends what the tool has so far, not what is new (`partialResult`), so the item is
    // updated with it instead of being sent as a delta.
    const text = resultText(event.partialResult);
    if (!text || text === item.text) return [];
    const next = { ...item, text };
    this.tools.set(toolCallId, next);
    return [{ type: 'item.updated', turnId: this.turnId, item: next }];
  }

  private toolEnd(event: PiRpcEvent): PiTurnEvent[] {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== 'string') return [];
    const started = this.tools.get(toolCallId);
    this.tools.delete(toolCallId);
    const toolName =
      typeof event.toolName === 'string' ? event.toolName : (started?.toolName ?? 'tool');
    const base: ProviderItem = started ?? {
      id: toolCallId,
      type: piItemType(toolName),
      status: 'in_progress',
      title: toolName,
      ...(isToolShaped(toolName) ? { toolName } : {}),
    };
    const status: ItemStatus = this.declined.has(toolCallId)
      ? 'declined'
      : event.isError === true
        ? 'failed'
        : 'completed';
    const text = resultText(event.result);
    const item: ProviderItem = { ...base, status, ...(text !== undefined ? { text } : {}) };
    const out: PiTurnEvent[] = [];
    if (!started) out.push({ type: 'item.started', turnId: this.turnId, item: base });
    out.push({ type: 'item.completed', turnId: this.turnId, item });
    return out;
  }

  private compactionStart(event: PiRpcEvent): PiTurnEvent[] {
    if (this.openCompaction) return [];
    this.compactionCount += 1;
    this.openCompaction = {
      id: `${this.turnId}:compaction:${this.compactionCount}`,
      type: 'context_compaction',
      status: 'in_progress',
      title: 'Context compaction',
      ...(typeof event.reason === 'string' ? { payload: { reason: event.reason } } : {}),
    };
    return [{ type: 'item.started', turnId: this.turnId, item: this.openCompaction }];
  }

  /**
   * A compaction ends. Its usage counts under the model Pi compacted with. When it was Pi's last
   * try to recover the turn's response it failed, Pi gives up on the turn, and the turn ends in
   * error with Pi's message: an overflow compaction (`reason: 'overflow'`) that ends without a
   * result, not aborted, not to be retried, with an `errorMessage`, after an assistant message
   * of this turn that did not `stop` (Pi retries only those, `core/agent-session.js:2438-2439`).
   * Pi writes it after one failed compact-and-retry with no `compaction_start` (`:2445-2464`:
   * "Truncated response recovery failed …", "Context overflow recovery failed …"), or when the
   * recovering compaction itself fails (`:2616-2632`). Other failed compactions only fail their
   * item: a threshold compaction (`:2474-2507`), or an overflow one after a response that did
   * `stop` (`:2440-2443`), comes after the answer, and one before the run (`:1480-1488`) comes
   * before any assistant message of the turn.
   */
  private compactionEnd(event: PiRpcEvent): PiTurnEvent[] {
    const result = record(event.result);
    if (
      result === undefined &&
      event.reason === 'overflow' &&
      event.aborted !== true &&
      event.willRetry !== true &&
      typeof event.errorMessage === 'string' &&
      event.errorMessage !== '' &&
      this.lastAssistantStop !== undefined &&
      this.lastAssistantStop !== 'stop'
    )
      this.recoveryError = event.errorMessage;
    const item = this.openCompaction;
    if (!item) return [];
    this.openCompaction = null;
    if (result) this.addUsage(this.model, result.usage);
    const ok = result !== undefined && event.aborted !== true;
    return [
      {
        type: 'item.completed',
        turnId: this.turnId,
        item: {
          ...item,
          status: ok ? 'completed' : 'failed',
          ...(typeof event.errorMessage === 'string' ? { text: event.errorMessage } : {}),
        },
      },
    ];
  }

  private retryStart(event: PiRpcEvent): PiTurnEvent[] {
    const attempt = typeof event.attempt === 'number' ? event.attempt : undefined;
    const max = typeof event.maxAttempts === 'number' ? event.maxAttempts : undefined;
    const why = typeof event.errorMessage === 'string' ? `: ${event.errorMessage}` : '';
    const count =
      attempt !== undefined && max !== undefined ? ` (attempt ${attempt} of ${max})` : '';
    return [
      {
        type: 'runtime.warning',
        turnId: this.turnId,
        message: `Pi is retrying the request${count}${why}`,
      },
    ];
  }

  private addUsage(model: string, raw: unknown): void {
    const usage = record(raw);
    if (!usage) return;
    const entry: TokenUsage = {
      model,
      inputTokens: count(usage.input),
      outputTokens: count(usage.output),
      cacheReadTokens: count(usage.cacheRead),
      cacheWriteTokens: count(usage.cacheWrite),
    };
    if (!spent(entry)) return;
    this.usage = mergeUsage(this.usage, [entry]);
  }

  private closeBlock(block: OpenBlock, status: ItemStatus): PiTurnEvent {
    return {
      type: 'item.completed',
      turnId: this.turnId,
      item: {
        id: block.itemId,
        type: block.type,
        status,
        title: firstLine(
          block.text,
          block.type === 'assistant_message' ? 'Assistant message' : 'Reasoning'
        ),
        text: block.text,
      },
    };
  }

  private blockId(index: number): string {
    return `${this.turnId}:message:${this.messageCount}:${index}`;
  }
}

/** The item type of a Pi tool (READY §2.5 item mapping). */
export function piItemType(toolName: string): ItemType {
  if (toolName === PI_COMMAND_TOOL) return 'command_execution';
  if (PI_FILE_CHANGE_TOOLS.has(toolName)) return 'file_change';
  if (toolName.startsWith('mcp__') || PI_MCP_RESOURCE_TOOLS.has(toolName)) return 'mcp_tool_call';
  return 'tool_call';
}

function isToolShaped(toolName: string): boolean {
  const type = piItemType(toolName);
  return type === 'mcp_tool_call' || type === 'tool_call';
}

function toolTitle(toolName: string, args: Record<string, unknown>): string {
  if (toolName === PI_COMMAND_TOOL && typeof args.command === 'string')
    return firstLine(args.command, 'Command');
  if (PI_FILE_CHANGE_TOOLS.has(toolName) && typeof args.path === 'string')
    return firstLine(args.path, 'File change');
  return toolName;
}

/** The text of a tool result (`{ content: [{ type: 'text', text }] }`), capped. */
function resultText(raw: unknown): string | undefined {
  const result = record(raw);
  if (!result || !Array.isArray(result.content)) return undefined;
  const text = result.content
    .map((part) => record(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join('\n');
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}… (${text.length - OUTPUT_LIMIT} more characters not shown)`;
}

function firstLine(text: string, fallback: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  if (!line) return fallback;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function spent(entry: TokenUsage): boolean {
  return (
    entry.inputTokens > 0 ||
    entry.outputTokens > 0 ||
    entry.cacheReadTokens > 0 ||
    entry.cacheWriteTokens > 0
  );
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
