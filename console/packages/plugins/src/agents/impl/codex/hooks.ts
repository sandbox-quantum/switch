import type { PluginFs } from '@switch-console/core/agents/plugins';
import type {
  CanonicalHookEvent,
  HookCommandOptions,
  HookRegistration,
} from '@switch-console/core/agents/plugins';
import {
  baseName,
  buildNestedJsonHookConfig,
  commandText,
  defaultHookEventParser,
  formatToolActivityLine,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  toolInputOf,
  toolNameOf,
} from '@switch-console/core/agents/plugins/helpers';
import * as toml from 'smol-toml';

export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const CODEX_CONFIG_PATH = '.codex/config.toml';

/**
 * Lets Codex run the hooks Switch Console installed without a persisted trust entry.
 *
 * Codex keys hook trust per entry in `~/.codex/config.toml`
 * (`[hooks.state."<hooks.json>:<event>:<group>:<index>"] trusted_hash`) and
 * skips any hook it has no entry for. Verified against 0.146.0: in `codex exec`
 * that skip is silent — no dump, no mention of the hook in the transcript — and
 * in the TUI it is a blocking startup review pane that a detached session has
 * nobody to answer. Either way Switch Console's own hooks would not run, taking the
 * session's status signals and its rollout-id capture with them, and rewriting a
 * hook command invalidates the entry a user had already granted.
 *
 * Switch Console writes those hooks itself, which is the case the flag is documented
 * for ("automation that already vets hook sources"). It is per-invocation and
 * covers every enabled hook, so a hook the user added to `~/.codex/hooks.json`
 * also runs unreviewed in Switch Console-launched sessions. Writing per-entry trust
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
 * The concrete thing a Codex tool acts on, for the " — <object>" suffix.
 *
 * Codex's built-in tool names are its own (`shell`, `unified_exec`,
 * `write_stdin`, `apply_patch`, `web_search`), so Claude's mapping does not
 * transfer. `shell` sends its command as an argv array rather than a string,
 * which {@link commandText} normalises.
 *
 * Deliberately best-effort: the tool *name* is what the status line is for, and
 * an unrecognised tool or an unexpected input shape drops the suffix rather
 * than the line. MCP tools (the Switch ones included) take no suffix — the tool
 * name already says what happened.
 */
function codexToolObject(body: Record<string, unknown>): string | undefined {
  const toolName = toolNameOf(body);
  const input = toolInputOf(body);
  const path = typeof input.path === 'string' ? input.path : undefined;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;

  switch (toolName) {
    case 'shell':
    case 'unified_exec':
    case 'write_stdin':
      return commandText(input.command ?? input.input);
    case 'apply_patch':
      return (filePath ?? path) ? baseName((filePath ?? path) as string) : undefined;
    case 'web_search':
      return typeof input.query === 'string' ? input.query : undefined;
    case 'view_image':
      return (filePath ?? path) ? baseName((filePath ?? path) as string) : undefined;
    default:
      return undefined;
  }
}

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

  if (eventType === 'tool-use' || eventType === 'tool-done') {
    const toolName = toolNameOf(body);
    if (!toolName) return { kind: 'ignore' };
    const verb = eventType === 'tool-use' ? 'Running tool' : 'Ran tool';
    return {
      kind: 'activity',
      detail: formatToolActivityLine(toolName, verb, codexToolObject(body)),
    };
  }

  return defaultHookEventParser(eventType, body);
}

export function buildCodexHookConfig() {
  // The tool hooks drive the runtime status line: without them a Codex session
  // reports only its opening "Working on it…" for the whole turn, because
  // nothing else can produce an `activity` event. Codex's own hook payload
  // carries `tool_name` / `tool_input`, the same shape Claude sends.
  //
  // No PostToolUse room-tracking matcher: since the agent-bridge push transport
  // (CHOO-1857), a session's room is driven by the connection Switch Console opens
  // and hands it as SWITCH_CONNECTION_ID, so `connect_to_room` claims the room
  // on that connection and the server reports it back. These two are unscoped
  // — every tool, no matcher.
  const base = buildNestedJsonHookConfig(CODEX_HOOKS_PATH, [
    { hookKey: 'Stop', command: makeNotificationHookCommand('idle_prompt') },
    { hookKey: 'PermissionRequest', command: makeNotificationHookCommand('permission_prompt') },
    { hookKey: 'SessionStart', command: makeStdinHookCommand('session-start') },
    { hookKey: 'PreToolUse', command: makeStdinHookCommand('tool-use') },
    { hookKey: 'PostToolUse', command: makeStdinHookCommand('tool-done') },
  ]);

  return {
    ...base,
    async writeHooks(
      fs: PluginFs,
      hooks: HookRegistration[],
      opts: HookCommandOptions
    ): Promise<string[]> {
      const paths = await base.writeHooks(fs, hooks, opts);
      await removeLegacyCodexNotify(fs);
      return paths;
    },
    parseHookEvent: parseCodexHookEvent,
  };
}
