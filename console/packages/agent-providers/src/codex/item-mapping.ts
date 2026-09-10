import type { ItemStatus, ItemType, ProviderItem } from '../events';
import type { CodexItemStatus, CodexThreadItem, CodexUnknownItem } from './protocol';

const TITLE_LIMIT = 200;

function firstLine(text: string, fallback: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  if (!line) return fallback;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function statusOf(status: CodexItemStatus): ItemStatus {
  switch (status) {
    case 'inProgress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'declined':
      return 'declined';
    default:
      return 'failed';
  }
}

/**
 * Codex items that carry no status of their own take it from the notification
 * that delivered them: `item/started` opens one, `item/completed` closes it.
 */
export type ItemLifecycle = 'started' | 'completed';

export function mapCodexItem(raw: CodexThreadItem, lifecycle: ItemLifecycle): ProviderItem {
  const lifecycleStatus: ItemStatus = lifecycle === 'started' ? 'in_progress' : 'completed';
  const item = raw;
  switch (item.type) {
    case 'userMessage':
      return { id: item.id, type: 'user_message', status: lifecycleStatus, title: 'User message' };
    case 'agentMessage':
      return {
        id: item.id,
        type: 'assistant_message',
        status: lifecycleStatus,
        title: firstLine(item.text, 'Assistant message'),
        text: item.text,
        payload: { phase: item.phase },
      };
    case 'reasoning': {
      const text = [...item.summary, ...item.content].join('\n');
      return {
        id: item.id,
        type: 'reasoning',
        status: lifecycleStatus,
        title: firstLine(text, 'Reasoning'),
        text,
      };
    }
    case 'commandExecution':
      return {
        id: item.id,
        type: 'command_execution',
        status: statusOf(item.status),
        title: firstLine(item.command, 'Command'),
        text: item.aggregatedOutput ?? undefined,
        payload: { command: item.command, cwd: item.cwd, exitCode: item.exitCode },
      };
    case 'fileChange': {
      const paths = item.changes.map((change) => change.path);
      return {
        id: item.id,
        type: 'file_change',
        status: statusOf(item.status),
        title: paths.length > 0 ? paths.join(', ').slice(0, TITLE_LIMIT) : 'File change',
        text: item.changes.map((change) => change.diff).join('\n'),
        payload: { changes: item.changes },
      };
    }
    case 'mcpToolCall':
      return {
        id: item.id,
        type: 'mcp_tool_call',
        status: statusOf(item.status),
        title: `${item.server}.${item.tool}`,
        toolName: item.tool,
        text: item.error?.message,
        payload: { server: item.server },
      };
    case 'dynamicToolCall':
      return {
        id: item.id,
        type: 'tool_call',
        status: statusOf(item.status),
        title: item.tool,
        toolName: item.tool,
      };
    case 'collabAgentToolCall':
      return {
        id: item.id,
        type: 'subagent',
        status: statusOf(item.status),
        title: item.tool,
        toolName: item.tool,
        text: item.prompt ?? undefined,
        payload: { senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds },
      };
    case 'subAgentActivity':
      return {
        id: item.id,
        type: 'subagent',
        status: lifecycleStatus,
        title: item.agentPath,
        toolName: item.agentPath,
        payload: { kind: item.kind, agentThreadId: item.agentThreadId },
      };
    case 'webSearch':
      return {
        id: item.id,
        type: 'web_search',
        status: lifecycleStatus,
        title: item.query ?? 'Web search',
      };
    case 'contextCompaction':
      return {
        id: item.id,
        type: 'context_compaction',
        status: lifecycleStatus,
        title: 'Context compaction',
      };
    default: {
      const unknown = item as CodexUnknownItem;
      const type: ItemType = 'tool_call';
      return { id: unknown.id, type, status: lifecycleStatus, title: unknown.type };
    }
  }
}
