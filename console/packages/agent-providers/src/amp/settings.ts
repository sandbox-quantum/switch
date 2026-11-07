import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import type { McpServerSpec, RuntimeMode } from '../adapter';

/**
 * Amp's tools that only read, which every mode runs without asking. A tool
 * missing from here and from {@link EDIT_TOOLS} is delegated to Switch, so an
 * unknown or new tool asks rather than runs.
 */
export const READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'glob',
  'read_web_page',
  'web_search',
  'todo_read',
  'todo_write',
  'Task',
] as const;

/** Amp's file-editing tools, which auto-accept-edits and auto mode run without asking. */
export const EDIT_TOOLS = ['edit_file', 'create_file', 'apply_patch', 'undo_edit'] as const;

/** Amp's shell tools, whose approval card shows the command. */
export const SHELL_TOOLS = new Set(['Bash', 'shell_command', 'async_shell_command']);

interface PermissionRule {
  tool: string;
  action: 'allow' | 'delegate';
  to?: string;
}

/**
 * The `amp.permissions` rules a session runs under, ahead of the person's own.
 *
 * Amp evaluates rules in order and has no prompt in execute mode, but a
 * `delegate` rule hands the decision to a program: it gets the tool's input on
 * stdin and `AGENT_TOOL_NAME` in its environment, and its exit status is the
 * answer (0 allow, 2 reject with stderr returned to the model). That program
 * is the session's approval helper, which waits for the person's answer in
 * Switch. Full access delegates nothing and turns on `amp.dangerouslyAllowAll`.
 */
export function permissionRules(input: {
  runtimeMode: RuntimeMode;
  autoApprovedMcpServers: readonly string[];
  helperPath: string;
}): PermissionRule[] {
  if (input.runtimeMode === 'full-access') return [];
  const allow = (tool: string): PermissionRule => ({ tool, action: 'allow' });
  return [
    ...input.autoApprovedMcpServers.map((server) => allow(`mcp__${server}__*`)),
    ...READ_ONLY_TOOLS.map(allow),
    ...(input.runtimeMode === 'approval-required' ? [] : EDIT_TOOLS.map(allow)),
    { tool: '*', action: 'delegate', to: input.helperPath },
  ];
}

/**
 * The person's own Amp settings file, which a session's settings start from so
 * their MCP servers, skills and the rest still apply. `--settings-file`
 * replaces it rather than adding to it.
 */
export function userSettingsPath(env: Record<string, string>): string {
  if (env.AMP_SETTINGS_FILE) return env.AMP_SETTINGS_FILE;
  return join(env.HOME || env.USERPROFILE || homedir(), '.config', 'amp', 'settings.json');
}

export async function readUserSettings(
  env: Record<string, string>
): Promise<{ settings: Record<string, unknown>; warning?: string }> {
  const base = userSettingsPath(env);
  for (const path of [base, base.replace(/\.json$/, '.jsonc')]) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (!errors.length && value && typeof value === 'object' && !Array.isArray(value))
      return { settings: value as Record<string, unknown> };
    return {
      settings: {},
      warning: `Could not read the Amp settings in ${path}, so this session runs without them.`,
    };
  }
  return { settings: {} };
}

/** The person's settings with the session's permission rules first. */
export function sessionSettings(
  user: Record<string, unknown>,
  input: { runtimeMode: RuntimeMode; rules: PermissionRule[] }
): Record<string, unknown> {
  const own = Array.isArray(user['amp.permissions']) ? user['amp.permissions'] : [];
  return {
    ...user,
    'amp.dangerouslyAllowAll': input.runtimeMode === 'full-access',
    'amp.permissions': [...input.rules, ...own],
  };
}

/** The session's MCP servers in the shape `--mcp-config` takes. */
export function mcpConfig(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, spec]) => {
      if (spec.transport === 'http')
        return [name, { url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }];
      const passed = Object.fromEntries(
        (spec.envVars ?? []).flatMap((key) => (env[key] !== undefined ? [[key, env[key]]] : []))
      );
      const serverEnv = { ...passed, ...spec.env };
      return [
        name,
        {
          command: spec.command,
          args: spec.args,
          ...(Object.keys(serverEnv).length ? { env: serverEnv } : {}),
        },
      ];
    })
  );
}

/**
 * The approval helper Amp delegates tool calls to. It writes the call into
 * the session's approvals directory, `<pid>.input` and `<pid>.tool` and then
 * `<pid>.request`, and waits for the adapter to write `<pid>.allow` or
 * `<pid>.deny` (the reason, returned to the model). It gives up, denying, when
 * the Amp process that started it is gone.
 */
export function approvalHelperScript(approvalsDir: string): string {
  const dir = `'${approvalsDir.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Written by Switch for one Amp session: hands each tool call Amp delegates
# to Switch and waits for the person's answer.
dir=${dir}
id="$$"
cat > "$dir/$id.input"
printf '%s\\n%s\\n' "$AGENT_TOOL_NAME" "$AGENT_TOOL_USE_ID" > "$dir/$id.tool"
: > "$dir/$id.request"
while :; do
  if [ -f "$dir/$id.allow" ]; then rm -f "$dir/$id".*; exit 0; fi
  if [ -f "$dir/$id.deny" ]; then cat "$dir/$id.deny" >&2; rm -f "$dir/$id".*; exit 2; fi
  if ! kill -0 "$PPID" 2>/dev/null; then rm -f "$dir/$id".*; exit 2; fi
  sleep 0.2
done
`;
}

/** Writes the session's approval helper and its directory; returns the helper's path. */
export async function writeApprovalHelper(sessionDir: string): Promise<{
  helperPath: string;
  approvalsDir: string;
}> {
  const approvalsDir = join(sessionDir, 'approvals');
  await mkdir(approvalsDir, { recursive: true });
  const helperPath = join(sessionDir, 'approve.sh');
  await writeFile(helperPath, approvalHelperScript(approvalsDir), 'utf8');
  await chmod(helperPath, 0o700);
  return { helperPath, approvalsDir };
}
