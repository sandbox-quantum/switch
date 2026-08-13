import type { CanonicalHookEvent, IHooksBehavior } from '@switch-console/core/agents/plugins';
import {
  baseName,
  collapseText,
  commandText,
  defaultHookEventParser,
  formatToolActivityLine,
  toolInputOf,
  toolNameOf,
} from '@switch-console/core/agents/plugins/helpers';

/** A trimmed non-empty string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The concrete thing an OpenCode tool acts on, for the " — <object>" suffix.
 *
 * OpenCode's built-in tool names are lowercase and its file tools key on
 * `filePath`, so neither Claude's nor Codex's mapping transfers.
 *
 * Deliberately best-effort: the tool *name* is what the status line is for, so
 * an unrecognised tool or an unexpected input shape drops the suffix rather
 * than the line.
 */
function opencodeToolObject(body: Record<string, unknown>): string | undefined {
  const toolName = toolNameOf(body);
  const input = toolInputOf(body);
  const filePath = str(input.filePath) ?? str(input.file_path) ?? str(input.path);

  switch (toolName) {
    case 'bash':
      return commandText(input.command);
    case 'edit':
    case 'write':
    case 'read':
    case 'list':
      return filePath ? baseName(filePath) : undefined;
    case 'grep':
    case 'glob': {
      const pattern = str(input.pattern);
      return pattern ? collapseText(pattern) : undefined;
    }
    case 'webfetch':
      return str(input.url);
    default:
      return undefined;
  }
}

/**
 * Parse an OpenCode hook event. Tool-call boundaries become `activity` events
 * that refresh the "working on it" detail line in place; everything else —
 * start / stop / error / session — uses the shared default parser.
 *
 * `task` is dropped: it is a subagent spawn, so its activity is the child's
 * work rather than a step the user is waiting on here, and reporting it
 * overwrites the line the child is already updating.
 */
export function parseOpencodeHookEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'tool-use' || eventType === 'tool-done') {
    const toolName = toolNameOf(body);
    if (!toolName || toolName === 'task') return { kind: 'ignore' };
    const verb = eventType === 'tool-use' ? 'Running tool' : 'Ran tool';
    return {
      kind: 'activity',
      detail: formatToolActivityLine(toolName, verb, opencodeToolObject(body)),
    };
  }
  return defaultHookEventParser(eventType, body);
}

/**
 * Hooks behavior for OpenCode.
 *
 * OpenCode delivers hooks through a dropped plugin file (the `plugins`
 * file-drop capability) rather than config files, and the hook config methods
 * are only ever called for a `kind: 'config'` descriptor — so they are inert
 * here. The behavior exists to supply `parseHookEvent`, which is what turns the
 * plugin's tool-use / tool-done posts into activity lines.
 */
export function buildOpencodeHookBehavior(): IHooksBehavior {
  return {
    readHooks: async () => [],
    writeHooks: async () => [],
    deleteHooks: async () => {},
    getHooksInstalled: async () => false,
    parseHookEvent: parseOpencodeHookEvent,
  };
}
