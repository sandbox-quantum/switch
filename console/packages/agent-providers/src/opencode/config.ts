import type { McpServerSpec, RuntimeMode } from '../adapter';

export type OpencodePermissionAction = 'allow' | 'ask' | 'deny';

export interface OpencodePermissionRule {
  permission: string;
  pattern: string;
  action: OpencodePermissionAction;
}

export type OpencodeMcpEntry =
  | { type: 'local'; command: string[]; enabled: true; environment?: Record<string, string> }
  | { type: 'remote'; url: string; enabled: true; headers?: Record<string, string> };

export interface OpencodeConfigFile {
  $schema: string;
  permission: Record<string, OpencodePermissionAction>;
  mcp: Record<string, OpencodeMcpEntry>;
}

/**
 * Permissions OpenCode asks about that Switch never wants a prompt for: they
 * are reads, bookkeeping, or the very mechanisms the adapter maps onto its own
 * vocabulary (`question` becomes `user-input.requested`, `task` a `subagent`).
 */
const NEVER_ASK = [
  'read',
  'glob',
  'grep',
  'list',
  'lsp',
  'todowrite',
  'question',
  'skill',
  'task',
] as const;

const ASK_UNLESS_ALLOWED = [
  'bash',
  'webfetch',
  'websearch',
  'external_directory',
  'doom_loop',
] as const;

function editAction(mode: RuntimeMode): OpencodePermissionAction {
  return mode === 'auto-accept-edits' ? 'allow' : 'ask';
}

/**
 * The permission keys covering the tools of the MCP servers the caller
 * registered. OpenCode names an MCP permission `<server>_<tool>` and matches a
 * permission key as a glob, so one entry per server covers its whole surface.
 *
 * They are allowed rather than asked about because the session's own
 * `XDG_CONFIG_HOME` hides the user's MCP registrations: every server a session
 * has is one the caller put there for it to use. For Switch Console that is the
 * room protocol, and a session that must ask a human before it may speak in the
 * room cannot answer the room at all — including to ask.
 */
function mcpPermissionKeys(mcpNames: string[]): string[] {
  return mcpNames.map((name) => `${name}_*`);
}

/**
 * The `permission` block for the session's own config file. It governs the
 * paths that never consult the per-session ruleset — OpenCode evaluates
 * doom-loop detection and subagent sessions against the agent's config.
 */
export function permissionConfigFor(
  mode: RuntimeMode,
  mcpNames: string[]
): Record<string, OpencodePermissionAction> {
  if (mode === 'full-access') return { '*': 'allow', external_directory: 'allow' };
  const config: Record<string, OpencodePermissionAction> = { '*': 'ask', edit: editAction(mode) };
  for (const permission of NEVER_ASK) config[permission] = 'allow';
  for (const permission of mcpPermissionKeys(mcpNames)) config[permission] = 'allow';
  for (const permission of ASK_UNLESS_ALLOWED) config[permission] = 'ask';
  return config;
}

/** The per-session ruleset passed to `session.create` and re-asserted on resume. */
export function permissionRulesFor(
  mode: RuntimeMode,
  mcpNames: string[]
): OpencodePermissionRule[] {
  if (mode === 'full-access') {
    return [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'allow' },
    ];
  }
  return [
    { permission: '*', pattern: '*', action: 'ask' },
    { permission: 'edit', pattern: '*', action: editAction(mode) },
    ...NEVER_ASK.map((permission) => ({ permission, pattern: '*', action: 'allow' as const })),
    ...mcpPermissionKeys(mcpNames).map((permission) => ({
      permission,
      pattern: '*',
      action: 'allow' as const,
    })),
    ...ASK_UNLESS_ALLOWED.map((permission) => ({
      permission,
      pattern: '*',
      action: 'ask' as const,
    })),
  ];
}

export function mcpConfigFor(
  servers: Record<string, McpServerSpec>
): Record<string, OpencodeMcpEntry> {
  const entries: Record<string, OpencodeMcpEntry> = {};
  for (const [name, spec] of Object.entries(servers)) {
    entries[name] =
      spec.transport === 'stdio'
        ? {
            type: 'local',
            command: [spec.command, ...spec.args],
            enabled: true,
            ...(spec.env ? { environment: spec.env } : {}),
          }
        : {
            type: 'remote',
            url: spec.url,
            enabled: true,
            ...(spec.headers ? { headers: spec.headers } : {}),
          };
  }
  return entries;
}

export function buildConfigFile(
  mode: RuntimeMode,
  servers: Record<string, McpServerSpec>
): OpencodeConfigFile {
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: permissionConfigFor(mode, Object.keys(servers)),
    mcp: mcpConfigFor(servers),
  };
}

/** `provider/model` is how OpenCode names a model everywhere else in its API. */
export function parseModelId(id: string): { providerID: string; modelID: string } {
  const separator = id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`OpenCode model must be given as 'provider/model', got '${id}'`);
  }
  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) };
}
