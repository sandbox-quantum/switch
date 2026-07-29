import type { PluginFs } from '@switchdash/core/agents/plugins';
import type { CanonicalHookEvent, HookRegistration } from '@switchdash/core/agents/plugins';
import {
  buildNestedJsonHookConfig,
  defaultHookEventParser,
  makeHookPostCommand,
  makeNotificationHookCommand,
} from '@switchdash/core/agents/plugins/helpers';
import * as toml from 'smol-toml';

export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const CODEX_CONFIG_PATH = '.codex/config.toml';

const LEGACY_CODEX_NOTIFY_COMMAND = [
  'bash',
  '-c',
  'curl -sf -X POST ' +
    "-H 'Content-Type: application/json' " +
    '-H "X-Switchdash-Token: $SWITCHDASH_HOOK_TOKEN" ' +
    '-H "X-Switchdash-Pty-Id: $SWITCHDASH_PTY_ID" ' +
    '-H "X-Switchdash-Event-Type: notification" ' +
    '-d "$1" ' +
    '"http://127.0.0.1:$SWITCHDASH_HOOK_PORT/hook" || true',
  '_',
];

function isLegacyCodexNotify(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (JSON.stringify(value) === JSON.stringify(LEGACY_CODEX_NOTIFY_COMMAND)) return true;
  const [command, noProfile, fileFlag, scriptPath] = value.map((item) => String(item));
  return (
    command.toLowerCase() === 'powershell.exe' &&
    noProfile === '-NoProfile' &&
    fileFlag === '-File' &&
    typeof scriptPath === 'string' &&
    scriptPath.endsWith('switchdash-codex-notify.ps1')
  );
}

async function removeLegacyCodexNotify(fs: PluginFs): Promise<void> {
  const raw = await fs.read(CODEX_CONFIG_PATH);
  if (!raw) return;

  let config: Record<string, unknown>;
  try {
    config = toml.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (!isLegacyCodexNotify(config.notify)) return;

  delete config.notify;
  await fs.write(CODEX_CONFIG_PATH, toml.stringify(config));
}

/**
 * A hook command that forwards Codex's event payload to switchdash.
 *
 * Codex documents stdin delivery, but its notify-style hooks have historically
 * passed the payload as `$1`, so accept either rather than depending on which
 * one a given event uses.
 */
function makeCodexStdinCommand(eventType: string): string {
  const post = makeHookPostCommand(eventType, 'stdin', {});
  if (process.platform === 'win32') return post;
  return `INPUT="\${1:-$(cat)}"; printf '%s' "$INPUT" | ${post}`;
}

/**
 * Tool-name pattern for the Switch `connect_to_room` MCP tool. The server name
 * is part of the tool name, and switchdash registers the server as `switch`,
 * but a session may reach Switch through a differently-named server — so match
 * any server exposing the tool rather than pinning to one name.
 */
export const CODEX_ROOM_CONNECT_MATCHER = 'mcp__.*__connect_to_room';

/**
 * Event type the room-tracking hook reports. Consumed by the hook service's
 * event enricher, which reads `room_id`/`agent_id` out of the tool response and
 * repoints the session's room. Shared with Claude's connector, which emits the
 * same event from the equivalent PostToolUse hook.
 */
const SWITCH_ROOM_CONNECT_EVENT = 'switch_room_connect';

/**
 * Codex sends `{ type: 'agent-turn-complete' }` as its stop signal instead
 * of a plain 'stop' event type, and uses fixed `notification_type` values
 * in its hook payloads rather than piping JSON.
 */
function parseCodexHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'session-start') {
    const candidates = [body.session_id, body.resource_id, body.resourceId, body.sessionId];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return { kind: 'session', providerSessionId: candidate.trim() };
      }
    }
    return { kind: 'ignore' };
  }

  if (eventType === 'notification') {
    const nt = body.notification_type;
    if (nt === 'idle_prompt' || (typeof nt !== 'string' && body.type === 'agent-turn-complete')) {
      return { kind: 'status', type: 'stop' };
    }
    if (nt === 'permission_prompt') {
      return { kind: 'status', type: 'notification', notificationType: 'permission_prompt' };
    }
  }

  return defaultHookEventParser(eventType, body);
}

export function buildCodexHookConfig() {
  const base = buildNestedJsonHookConfig(CODEX_HOOKS_PATH, [
    { hookKey: 'Stop', command: makeNotificationHookCommand('idle_prompt') },
    { hookKey: 'PermissionRequest', command: makeNotificationHookCommand('permission_prompt') },
    { hookKey: 'SessionStart', command: makeCodexStdinCommand('session-start') },
    // Matcher-scoped to the Switch connect tool; the rest are lifecycle events
    // that carry no matcher.
    {
      hookKey: 'PostToolUse',
      command: makeCodexStdinCommand(SWITCH_ROOM_CONNECT_EVENT),
      matcher: CODEX_ROOM_CONNECT_MATCHER,
    },
  ]);

  return {
    ...base,
    async writeHooks(fs: PluginFs, hooks: HookRegistration[]): Promise<string[]> {
      const paths = await base.writeHooks(fs, hooks);
      await removeLegacyCodexNotify(fs);
      return paths;
    },
    parseHookEvent: parseCodexHookEvent,
  };
}
