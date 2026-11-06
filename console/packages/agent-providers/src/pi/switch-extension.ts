/**
 * The Pi extension every Switch session loads with `-e`, written into the
 * session's own folder at launch so the person's Pi configuration is never
 * touched. It reads the session's settings from the file `SWITCH_PI_CONFIG`
 * names, and:
 *
 * - registers the session's MCP servers for this session only, with their
 *   tools declared to the model (`exposure: "direct"`);
 * - asks Switch before a tool runs, through a `ctx.ui.select` dialog that
 *   arrives as an `extension_ui_request`, following the session's runtime
 *   mode. A `setStatus` record under {@link PI_APPROVAL_STATUS} just before the
 *   dialog says which tool call it is about. A `tool_call` handler that throws
 *   blocks the tool, so a failure here never lets a call through unasked.
 *
 * Plain JavaScript, so Pi loads it without a TypeScript step.
 */
export const PI_APPROVAL_STATUS = 'switch.approval';

/** The choices the approval dialog offers, in order. */
export const PI_APPROVAL_OPTIONS = {
  accept: 'Allow once',
  acceptForSession: 'Allow for this session',
  decline: 'Reject',
} as const;

/** What a session's extension is told, as JSON in the file `SWITCH_PI_CONFIG` names. */
export interface PiExtensionConfig {
  runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
  /** Pi `mcpServers` entries, keyed by server name. */
  mcpServers: Record<string, Record<string, unknown>>;
  /** Servers whose tools run without asking in every mode: all but the connectors. */
  autoApproved: string[];
}

export const PI_SWITCH_EXTENSION = `import { readFileSync } from 'node:fs';

const STATUS = ${JSON.stringify(PI_APPROVAL_STATUS)};
const OPTIONS = ${JSON.stringify(PI_APPROVAL_OPTIONS)};
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls', 'tool_search']);
const EDITS = new Set(['edit', 'write']);
const safe = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');

export function mcpServerOf(toolName) {
  if (!toolName.startsWith('mcp__')) return undefined;
  const end = toolName.indexOf('__', 5);
  return end > 5 ? toolName.slice(5, end) : undefined;
}

export function asks(config, toolName) {
  if (config.runtimeMode === 'full-access' || READ_ONLY.has(toolName)) return false;
  const server = mcpServerOf(toolName);
  if (server !== undefined && config.autoApproved.some((name) => safe(name) === safe(server)))
    return false;
  if (EDITS.has(toolName) && config.runtimeMode === 'auto-accept-edits') return false;
  return true;
}

export default function switchExtension(pi) {
  const config = JSON.parse(readFileSync(process.env.SWITCH_PI_CONFIG, 'utf8'));
  for (const [name, server] of Object.entries(config.mcpServers))
    pi.registerMcpServer(name, { ...server, exposure: 'direct' });
  const allowedForSession = new Set();
  pi.on('tool_call', async (event, ctx) => {
    if (!asks(config, event.toolName) || allowedForSession.has(event.toolName)) return undefined;
    ctx.ui.setStatus(
      STATUS,
      JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input })
    );
    const choice = await ctx.ui.select('Allow ' + event.toolName + '?', [
      OPTIONS.accept,
      OPTIONS.acceptForSession,
      OPTIONS.decline,
    ]);
    ctx.ui.setStatus(STATUS, undefined);
    if (choice === OPTIONS.accept) return undefined;
    if (choice === OPTIONS.acceptForSession) {
      allowedForSession.add(event.toolName);
      return undefined;
    }
    return {
      block: true,
      reason:
        choice === OPTIONS.decline
          ? 'The user declined this tool call.'
          : 'The approval was cancelled, so the tool did not run.',
    };
  });
}
`;
