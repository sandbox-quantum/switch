import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationHistoryItem, ConversationHistoryTurn } from '../adapter';
import { isRecord, toolTitle } from './claude-mapping';

/** How Claude Code records a slash command someone ran: `<command-name>/mcp</command-name>…`. */
const SLASH_COMMAND = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;
/** A shell command someone ran with `!`. */
const BASH_INPUT = /<bash-input>([^<]*)<\/bash-input>/;
/** Claude Code's note that someone stopped a turn: not a prompt. */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
/**
 * How Claude Code's summary of a compacted conversation opens. It is recorded
 * as a user entry, and the SDK's reader does not say which entry it is.
 */
const COMPACTION_SUMMARY = /^This session is being continued from a previous conversation/;
const OPENING_TAG = /^<([a-z][\w-]*)(?:\s[^>]*)?>/;
/**
 * The tags Claude Code wraps around what it adds to a conversation on its own.
 * Only these are left out: a person who pastes `<div>…</div>` as a prompt
 * still sees it.
 */
const ADDED_CONTEXT_TAGS = new Set([
  'bash-stderr',
  'bash-stdout',
  'command-args',
  'command-message',
  'command-name',
  'ide_diagnostics',
  'ide_opened_file',
  'ide_selection',
  'local-command-caveat',
  'local-command-stderr',
  'local-command-stdout',
  'system-reminder',
  'task-notification',
  'user-prompt-submit-hook',
]);

/**
 * A Claude Code conversation as transcript turns: each prompt someone typed
 * starts a turn, and what Claude said and the tools it ran follow it.
 *
 * Reasoning is left out, as it is from a live transcript, and so are a
 * subagent's own messages: the tool call that started the subagent stands for
 * it. A tool whose result was an error is shown as failed.
 */
export function historyFromClaudeMessages(messages: SessionMessage[]): ConversationHistoryTurn[] {
  const turns: ConversationHistoryTurn[] = [];
  const tools = new Map<string, ConversationHistoryItem>();
  let turn: ConversationHistoryTurn | null = null;
  const add = (uuid: string, item: ConversationHistoryItem) => {
    if (!turn) {
      turn = { turnId: uuid, items: [] };
      turns.push(turn);
    }
    turn.items.push(item);
  };
  for (const message of messages) {
    if (message.parent_tool_use_id !== null) continue;
    const content = isRecord(message.message) ? message.message.content : undefined;
    const blocks =
      typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content)
          ? content.filter(isRecord)
          : [];
    if (message.type === 'user') {
      for (const block of blocks)
        if (block.type === 'tool_result' && block.is_error === true) {
          const tool = typeof block.tool_use_id === 'string' && tools.get(block.tool_use_id);
          if (tool) tool.status = 'failed';
        }
      const texts = blocks.flatMap((block) =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []
      );
      if (texts.some((text) => COMPACTION_SUMMARY.test(text))) {
        turn = { turnId: message.uuid, items: [] };
        turns.push(turn);
        add(message.uuid, {
          itemId: message.uuid,
          kind: 'tool-activity',
          status: 'completed',
          title: 'Conversation compacted: the turns before this were summarized',
          text: '',
        });
        continue;
      }
      const prompt = blocks
        .map((block) =>
          block.type === 'text' && typeof block.text === 'string'
            ? promptText(block.text)
            : block.type === 'image'
              ? '[image]'
              : ''
        )
        .filter(Boolean)
        .join('\n\n');
      if (!prompt) continue;
      turn = { turnId: message.uuid, items: [] };
      turns.push(turn);
      add(message.uuid, {
        itemId: message.uuid,
        kind: 'user-message',
        status: 'completed',
        title: '',
        text: prompt,
      });
    } else if (message.type === 'assistant') {
      blocks.forEach((block, index) => {
        const itemId = `${message.uuid}:${index}`;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim())
          add(message.uuid, {
            itemId,
            kind: 'assistant-message',
            status: 'completed',
            title: '',
            text: block.text,
          });
        else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const tool: ConversationHistoryItem = {
            itemId,
            kind: 'tool-activity',
            status: 'completed',
            title: toolTitle(block.name, isRecord(block.input) ? block.input : {}),
            text: '',
          };
          add(message.uuid, tool);
          if (typeof block.id === 'string') tools.set(block.id, tool);
        }
      });
    }
  }
  return turns;
}

/**
 * What a person typed in one text block: a slash command or `!` command as they
 * typed it; nothing for what Claude Code added on its own, or its note that a
 * turn was stopped.
 */
function promptText(text: string): string {
  const trimmed = text.trim();
  const command = SLASH_COMMAND.exec(trimmed);
  if (command) {
    const args = COMMAND_ARGS.exec(trimmed)?.[1]?.trim();
    return [command[1]!.trim(), args].filter(Boolean).join(' ');
  }
  const shell = BASH_INPUT.exec(trimmed);
  if (shell) return `! ${shell[1]!.trim()}`;
  if (INTERRUPTED.test(trimmed) || onlyAddedContext(trimmed)) return '';
  return trimmed;
}

/**
 * Whether a text is blocks of Claude Code's own tags and nothing else, such as
 * `<task-notification>…</task-notification>` or a command's
 * `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`: context Claude
 * Code added to the conversation, not something a person typed. Walked rather
 * than matched with one pattern, which would backtrack on a long paste.
 */
function onlyAddedContext(text: string): boolean {
  let rest = text;
  if (!rest) return false;
  while (rest) {
    const open = OPENING_TAG.exec(rest);
    if (!open || !ADDED_CONTEXT_TAGS.has(open[1]!)) return false;
    const closing = `</${open[1]}>`;
    const end = rest.indexOf(closing, open[0].length);
    if (end < 0) return false;
    rest = rest.slice(end + closing.length).trimStart();
  }
  return true;
}
