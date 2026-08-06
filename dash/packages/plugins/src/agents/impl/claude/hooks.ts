import type { CanonicalHookEvent, NotificationType } from '@switchdash/core/agents/plugins';
import {
  baseName,
  buildNestedJsonHookConfig,
  commandText,
  defaultHookEventParser,
  formatToolActivityLine,
  makeStdinHookCommand,
  toolInputOf,
  toolLabel,
  toolNameOf,
} from '@switchdash/core/agents/plugins/helpers';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';

/** The Bash command off a tool body, whitespace-collapsed and truncated. */
function shortCommand(body: Record<string, unknown>): string | undefined {
  return commandText(toolInputOf(body).command);
}

/**
 * The concrete thing a tool acts on, for a compact " — <object>" suffix: the
 * file for edit/read tools, the command for Bash, the pattern for search, the
 * query/url for web tools. Undefined when there's nothing worth appending.
 */
function toolObject(body: Record<string, unknown>): string | undefined {
  const toolName = toolNameOf(body);
  const input = toolInputOf(body);
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
  const query = typeof input.query === 'string' ? input.query : undefined;
  const url = typeof input.url === 'string' ? input.url : undefined;

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return filePath ? baseName(filePath) : undefined;
    case 'Bash':
      return shortCommand(body);
    case 'Grep':
    case 'Glob':
      return pattern;
    case 'WebFetch':
      return url;
    case 'WebSearch':
      return query;
    default:
      return undefined;
  }
}

/**
 * A tool activity line, e.g. "_Running tool_ `Edit` — foo.py". `verb` is the
 * italicised lead ("Running tool" for PreToolUse, "Ran tool" for PostToolUse);
 * the tool name is code-formatted and the object (file/command/…) trails after
 * an em dash when available. Returns undefined for the `Task` tool — subagent
 * lifecycle is surfaced by the SubagentStart/Stop hooks instead — and when no
 * tool name is present.
 */
function toolActivityLine(body: Record<string, unknown>, verb: string): string | undefined {
  const toolName = toolNameOf(body);
  if (!toolName || toolName === 'Task') return undefined;
  return formatToolActivityLine(toolName, verb, toolObject(body));
}

/**
 * A PostToolUseFailure line, e.g. "`Bash` _failed_ — pytest -q", so a broken
 * call is surfaced instead of silently rolling past.
 */
function deriveFailureDetail(body: Record<string, unknown>): string | undefined {
  const toolName = toolNameOf(body);
  if (!toolName) return undefined;
  const object = toolObject(body);
  return `\`${toolLabel(toolName)}\` _failed_` + (object ? ` — ${object}` : '');
}

/**
 * Subagent lifecycle lines naming the agent, e.g. "_Delegating to_ `Explore`"
 * on start and "_Subagent_ `Explore` _finished_" on stop. The name comes from
 * the hook's `agent_type`; these fire when the subagent truly spawns/finishes.
 */
function deriveSubagentDetail(body: Record<string, unknown>, finished: boolean): string {
  const agentType = typeof body.agent_type === 'string' ? body.agent_type.trim() : '';
  if (finished) {
    return agentType ? `_Subagent_ \`${agentType}\` _finished_` : '_Subagent finished_';
  }
  return agentType ? `_Delegating to_ \`${agentType}\`` : '_Delegating to a subagent_';
}

const KNOWN_NOTIFICATION_TYPES = new Set<NotificationType>([
  'permission_prompt',
  'idle_prompt',
  'auth_success',
  'elicitation_dialog',
]);

/**
 * Classify a Claude Notification. Newer Claude Code stamps a `notification_type`
 * (e.g. `permission_prompt`, `agent_needs_input`, `idle_prompt`) — prefer it.
 * Fall back to sniffing the message text for older builds that omit the field:
 *   /permission|approval|input/i → permission_prompt
 *   everything else              → idle_prompt (agent waiting / done)
 */
function classifyNotification(body: Record<string, unknown>, message: string): NotificationType {
  const raw = body.notification_type ?? body.notificationType;
  if (typeof raw === 'string') {
    if (KNOWN_NOTIFICATION_TYPES.has(raw as NotificationType)) return raw as NotificationType;
    // Typed but outside our enum (e.g. agent_needs_input) — map by intent.
    if (/permission|approval|input/i.test(raw)) return 'permission_prompt';
    if (/idle|complete/i.test(raw)) return 'idle_prompt';
  }
  return /permission|approval|input/i.test(message) ? 'permission_prompt' : 'idle_prompt';
}

function parseClaudeHookEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'notification') {
    const message = typeof body.message === 'string' ? body.message : '';
    return {
      kind: 'status',
      type: 'notification',
      notificationType: classifyNotification(body, message),
      message: message || undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }

  if (eventType === 'tool-use' || eventType === 'tool-done') {
    const verb = eventType === 'tool-use' ? 'Running tool' : 'Ran tool';
    const detail = toolActivityLine(body, verb);
    return detail ? { kind: 'activity', detail } : { kind: 'ignore' };
  }

  if (eventType === 'tool-use-failure') {
    const detail = deriveFailureDetail(body);
    return detail ? { kind: 'activity', detail } : { kind: 'ignore' };
  }

  if (eventType === 'subagent' || eventType === 'subagent-done') {
    return { kind: 'activity', detail: deriveSubagentDetail(body, eventType === 'subagent-done') };
  }

  return defaultHookEventParser(eventType, body);
}

export function buildClaudeHookConfig() {
  return {
    ...buildNestedJsonHookConfig(CLAUDE_SETTINGS_PATH, [
      { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
      { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
      { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
      // Switch room detection: report the room a session connects to so
      // switchdash can surface membership and drive notification injection.
      {
        hookKey: 'PostToolUse',
        matcher: 'mcp__.*__connect_to_room',
        command: makeStdinHookCommand('switch_room_connect'),
      },
      // Per-turn activity: PreToolUse surfaces the tool starting ("Running tool
      // `x`") so long-running work shows in-progress, PostToolUse marks it done
      // ("Ran tool `x`"). The bridge refreshes the "working on it…" message in
      // place; identical consecutive lines are deduped.
      { hookKey: 'PreToolUse', command: makeStdinHookCommand('tool-use') },
      { hookKey: 'PostToolUse', command: makeStdinHookCommand('tool-done') },
      // Surface a failed tool call rather than silently moving past it.
      { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('tool-use-failure') },
      // Name a subagent as it spawns and again when it finishes.
      { hookKey: 'SubagentStart', command: makeStdinHookCommand('subagent') },
      { hookKey: 'SubagentStop', command: makeStdinHookCommand('subagent-done') },
    ]),
    parseHookEvent: parseClaudeHookEvent,
  };
}
