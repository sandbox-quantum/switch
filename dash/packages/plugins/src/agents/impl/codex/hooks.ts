import type { PluginFs } from '@switchdash/core/agents/plugins';
import type { CanonicalHookEvent, HookRegistration } from '@switchdash/core/agents/plugins';
import {
  buildNestedJsonHookConfig,
  defaultHookEventParser,
  makeNotificationHookCommand,
  makeStdinHookCommand,
} from '@switchdash/core/agents/plugins/helpers';
import * as toml from 'smol-toml';

export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const CODEX_CONFIG_PATH = '.codex/config.toml';

/**
 * Lets Codex run the hooks switchdash installed without a persisted trust entry.
 *
 * Codex keys hook trust per entry in `~/.codex/config.toml`
 * (`[hooks.state."<hooks.json>:<event>:<group>:<index>"] trusted_hash`) and
 * skips any hook it has no entry for. Verified against 0.146.0: in `codex exec`
 * that skip is silent — no dump, no mention of the hook in the transcript — and
 * in the TUI it is a blocking startup review pane that a detached session has
 * nobody to answer. Either way switchdash's own hooks would not run, taking
 * room tracking and rollout-id capture with them, and rewriting a hook command
 * invalidates the entry a user had already granted.
 *
 * switchdash writes those hooks itself, which is the case the flag is documented
 * for ("automation that already vets hook sources"). It is per-invocation and
 * covers every enabled hook, so a hook the user added to `~/.codex/hooks.json`
 * also runs unreviewed in switchdash-launched sessions. Writing per-entry trust
 * instead would be narrower, but the hash input is undocumented and not
 * derivable from the command text, so it would break silently on a Codex change.
 */
export const CODEX_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

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
 * Tool-name pattern for the Switch `connect_to_room` MCP tool. The server name
 * is part of the tool name, and switchdash registers the server as `switch`,
 * but a session may reach Switch through a differently-named server — so match
 * any server exposing the tool rather than pinning to one name.
 */
export const CODEX_ROOM_CONNECT_MATCHER = 'mcp__.*__connect_to_room';

/**
 * Event type the room-tracking hook reports. Consumed by the hook service's
 * event enricher, which reads `room_id`/`agent_id` out of the tool response and
 * repoints the session's room. Claude's hook config emits the same event from
 * its equivalent PostToolUse hook, so both providers share one enricher path.
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
    { hookKey: 'SessionStart', command: makeStdinHookCommand('session-start') },
    // Matcher-scoped to the Switch connect tool; the rest are lifecycle events
    // that carry no matcher.
    {
      hookKey: 'PostToolUse',
      command: makeStdinHookCommand(SWITCH_ROOM_CONNECT_EVENT),
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
