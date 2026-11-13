import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationHistoryItem, ConversationHistoryTurn } from '../adapter';
import { isRecord, toolTitle } from './claude-mapping';

/** Claude Code's note that someone stopped a turn: not a prompt. */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
/**
 * How Claude Code's summary of a compacted conversation opens. It is recorded
 * as a user entry, and the SDK's reader does not say which entry it is.
 */
const COMPACTION_SUMMARY = /^This session is being continued from a previous conversation/;
const OPENING_TAG = /^<([a-z][\w-]*)(?:\s[^>]*)?>/;
/**
 * The tags Claude Code wraps around what it records on its own: the context it
 * adds, and how it records a slash command someone ran
 * (`<command-name>/mcp</command-name>…`) or a shell command run with `!`
 * (`<bash-input>…</bash-input>`). Only text made of nothing but these is read
 * as Claude Code's: a person who pastes `<div>…</div>`, or a prompt that
 * quotes one of these tags, still sees what they typed.
 */
const ADDED_CONTEXT_TAGS = new Set([
  'bash-input',
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
 * turn was stopped; and anything else as it was typed.
 */
function promptText(text: string): string {
  const trimmed = text.trim();
  if (INTERRUPTED.test(trimmed)) return '';
  const blocks = addedContextBlocks(trimmed);
  if (!blocks) return trimmed;
  const command = blocks.get('command-name');
  if (command !== undefined)
    return [command.trim(), blocks.get('command-args')?.trim()].filter(Boolean).join(' ');
  const shell = blocks.get('bash-input');
  if (shell !== undefined) return `! ${shell.trim()}`;
  return '';
}

/**
 * The contents of each of Claude Code's own tags in a text made of their
 * blocks and nothing else, such as `<task-notification>…</task-notification>`
 * or a command's `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`,
 * by tag, the first of each; null for any other text, which a person typed.
 * Walked rather than matched with one pattern, which would backtrack on a long
 * paste.
 */
function addedContextBlocks(text: string): Map<string, string> | null {
  const blocks = new Map<string, string>();
  let rest = text;
  if (!rest) return null;
  while (rest) {
    const open = OPENING_TAG.exec(rest);
    if (!open || !ADDED_CONTEXT_TAGS.has(open[1]!)) return null;
    const closing = `</${open[1]}>`;
    const end = rest.indexOf(closing, open[0].length);
    if (end < 0) return null;
    if (!blocks.has(open[1]!)) blocks.set(open[1]!, rest.slice(open[0].length, end));
    rest = rest.slice(end + closing.length).trimStart();
  }
  return blocks;
}
