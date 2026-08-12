import { Buffer } from 'node:buffer';
import type { HookCommandOptions, PluginFs } from '@switch-console/core/agents/plugins';
import type {
  CanonicalHookEvent,
  HookCommand,
  HookRegistration,
} from '@switch-console/core/agents/plugins';
import {
  SWITCHDASH_MARKER,
  buildNestedEntry,
  defaultHookEventParser,
  filterUserHooks,
  makeStdinHookCommand,
  readJsonConfig,
  writeJsonConfig,
} from '@switch-console/core/agents/plugins/helpers';

export const GROK_HOOKS_PATH = '.grok/hooks/switchdash.json';

function makeGrokSessionStartCommand(): HookCommand {
  return (opts: HookCommandOptions) =>
    opts.platform === 'win32' ? grokWindowsSessionStart() : grokPosixSessionStart();
}

function grokWindowsSessionStart(): string {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'if (-not $env:SWITCHDASH_HOOK_PORT -or -not $env:SWITCHDASH_HOOK_TOKEN -or -not $env:SWITCHDASH_PTY_ID) { exit 0 }',
    '$payload = @{ session_id = $env:GROK_SESSION_ID } | ConvertTo-Json -Compress',
    'try { Invoke-WebRequest -UseBasicParsing -Method POST ' +
      "-Uri ('http://127.0.0.1:' + $env:SWITCHDASH_HOOK_PORT + '/hook') " +
      '-Headers @{ ' +
      "'Content-Type' = 'application/json'; " +
      "'X-Switchdash-Token' = $env:SWITCHDASH_HOOK_TOKEN; " +
      "'X-Switchdash-Pty-Id' = $env:SWITCHDASH_PTY_ID; " +
      "'X-Switchdash-Event-Type' = 'session' " +
      '} -Body $payload | Out-Null } catch { exit 0 }',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // No `cmd.exe /d /c "…"` wrapper, for the reason given on
  // makeWindowsHookPostCommand: a host's own shell wrapping can strip the
  // quotes, leaving cmd.exe to exit 0 without ever running the script.
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function grokPosixSessionStart(): string {
  return (
    'curl -sf -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "X-Switchdash-Token: $SWITCHDASH_HOOK_TOKEN" ' +
    '-H "X-Switchdash-Pty-Id: $SWITCHDASH_PTY_ID" ' +
    '-H "X-Switchdash-Event-Type: session" ' +
    `--data-binary '{"session_id":"'"$GROK_SESSION_ID"'"}' ` +
    '"http://127.0.0.1:$SWITCHDASH_HOOK_PORT/hook" || true'
  );
}

const hookEntries = () => [
  { hookKey: 'SessionStart', command: makeGrokSessionStartCommand() },
  { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
  { hookKey: 'PreToolUse', command: makeStdinHookCommand('start') },
  { hookKey: 'PostToolUse', command: makeStdinHookCommand('start') },
  { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('start') },
  { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
  { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
  { hookKey: 'StopFailure', command: makeStdinHookCommand('stop') },
  { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop') },
];

/**
 * Grok sends Notification events without a notification_type field.
 * All Grok notifications are permission-style prompts.
 */
function parseGrokHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'notification') {
    return {
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
      message: typeof body.message === 'string' ? body.message : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }
  return defaultHookEventParser(eventType, body);
}

export function buildGrokHookConfig() {
  const specs = hookEntries();
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, GROK_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = specs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
      return installed ? [{ event: 'switchdash', command: SWITCHDASH_MARKER }] : [];
    },
    async writeHooks(
      fs: PluginFs,
      _hooks: HookRegistration[],
      opts: HookCommandOptions
    ): Promise<string[]> {
      const config = await readJsonConfig(fs, GROK_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const { hookKey, command } of specs) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = [
          ...filterUserHooks(existing as Record<string, unknown>[]),
          buildNestedEntry(command(opts)),
        ];
      }
      await writeJsonConfig(fs, GROK_HOOKS_PATH, { ...config, hooks });
      return [GROK_HOOKS_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfig(fs, GROK_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      for (const key of Object.keys(hooks)) {
        hooks[key] = filterUserHooks(hooks[key] as Record<string, unknown>[]);
      }
      await writeJsonConfig(fs, GROK_HOOKS_PATH, { ...config, hooks });
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, GROK_HOOKS_PATH);
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return specs.some(({ hookKey }) => {
        const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        return entries.some((e) => JSON.stringify(e).includes(SWITCHDASH_MARKER));
      });
    },
    parseHookEvent: parseGrokHookEvent,
  };
}
