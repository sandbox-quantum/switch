import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerSpec } from '../adapter';
import {
  APPROVAL_OPTIONS,
  DIALOG_PREFIX,
  SWITCH_EXTENSION_COMMAND,
  SWITCH_EXTENSION_CONFIG_ENV,
  type SwitchExtensionConfig,
} from './protocol';

/**
 * The Pi extension every Switch session loads (`pi -e <file>`).
 *
 * Pi has no permission system, no way to ask the user a question, and no
 * per-session MCP configuration outside its own files. This extension adds the
 * three, for this session only:
 *
 * - it registers the session's MCP servers (`pi.registerMcpServer`, which is
 *   never saved), in `direct` exposure so the model sees Switch's room tools
 *   as tools of their own;
 * - it gates every tool call on the runtime mode (`tool_call`, which MCP
 *   tools pass through too) and asks through one `select` dialog the adapter
 *   recognises (`decodeDialog`);
 * - it gives the model an `ask_user` tool, which asks the same way.
 *
 * It is plain JavaScript with no imports from Pi, so it loads wherever Pi
 * runs and a test can import it directly. The adapter checks that it loaded
 * (`SWITCH_EXTENSION_COMMAND`) before a session starts, because Pi carries on
 * without an extension that failed, and a session without the gate would run
 * tools it should have asked about.
 */
export const SWITCH_EXTENSION_SOURCE = `import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.env.${SWITCH_EXTENSION_CONFIG_ENV}, 'utf8'));
// The file holds the session's MCP credentials and the adapter removes it once
// Pi is up. Dropping its name keeps it out of the commands the model runs.
delete process.env.${SWITCH_EXTENSION_CONFIG_ENV};

const DIALOG_PREFIX = ${JSON.stringify(DIALOG_PREFIX)};
const [ALLOW_ONCE, ALLOW_FOR_SESSION, REJECT] = ${JSON.stringify(APPROVAL_OPTIONS)};

// Tools that only look, and the ones that never reach anything outside this
// conversation. Everything else asks, including a tool this file has never
// heard of.
const ALLOWED_TOOLS = new Set([
  'read', 'ls', 'grep', 'find', 'ask_user', 'tool_search', 'codemode',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
]);
const EDIT_TOOLS = new Set(['edit', 'write']);

const connectors = new Set(config.connectorMcpServers);
// Pi names an MCP server's tool mcp__<server>__<tool>, with every character of
// the server's name other than a letter, digit or "_" turned into "_".
const prefixes = Object.keys(config.mcpServers).map((name) => ({
  name,
  prefix: 'mcp__' + name.replace(/[^A-Za-z0-9_]/g, '_') + '__',
}));

/** The MCP server a tool belongs to; trusted when Switch registered it and it is no connector. */
function mcpServerOf(toolName) {
  const own = prefixes.find(({ prefix }) => toolName.startsWith(prefix));
  if (own) return { name: own.name, trusted: !connectors.has(own.name), connector: connectors.has(own.name) };
  // A server from the person's own Pi configuration: not Switch's to vouch for.
  const other = /^mcp__([A-Za-z0-9_]+?)__/.exec(toolName);
  return other ? { name: other[1], trusted: false, connector: false } : undefined;
}

function needsApproval(toolName, server) {
  if (config.runtimeMode === 'full-access' || ALLOWED_TOOLS.has(toolName)) return false;
  if (server?.trusted) return false;
  return !(config.runtimeMode === 'auto-accept-edits' && EDIT_TOOLS.has(toolName));
}

const dialog = (body) => DIALOG_PREFIX + JSON.stringify(body);
const approvedForSession = new Set();

export default function (pi) {
  for (const [name, server] of Object.entries(config.mcpServers))
    pi.registerMcpServer(name, { ...server, exposure: 'direct' });

  // Pi has no mode that asks, so there is no reviewer here either: 'auto' asks
  // wherever 'approval-required' does.
  pi.on('tool_call', async (event, ctx) => {
    const server = mcpServerOf(event.toolName);
    if (!needsApproval(event.toolName, server) || approvedForSession.has(event.toolName)) return;
    const choice = await ctx.ui.select(
      dialog({
        kind: 'approval',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(server ? { server: server.name, connector: server.connector } : {}),
      }),
      [ALLOW_ONCE, ALLOW_FOR_SESSION, REJECT],
      { signal: ctx.signal }
    );
    if (choice === ALLOW_FOR_SESSION) approvedForSession.add(event.toolName);
    if (choice === ALLOW_ONCE || choice === ALLOW_FOR_SESSION) return;
    return {
      block: true,
      reason: choice === REJECT ? 'Denied by the user in Switch.' : 'The approval request was cancelled.',
    };
  });

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the user',
    description:
      'Ask the user a multiple-choice question and wait for the answer. Use it when you need a decision or a missing detail before you can continue.',
    promptSnippet: 'Ask the user a multiple-choice question and wait for the answer',
    promptGuidelines: ['Use ask_user, not a question in your reply, when you need the user to choose before you continue.'],
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The answers to choose from' },
        header: { type: 'string', description: 'A short title for the question' },
        multiSelect: { type: 'boolean', description: 'Whether more than one answer may be chosen' },
      },
      required: ['question', 'options'],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const multiSelect = params.multiSelect === true;
      const answer = await ctx.ui.select(
        dialog({ kind: 'question', question: params.question, header: params.header, multiSelect }),
        params.options,
        { signal }
      );
      // A multiple choice comes back as a JSON array of the options chosen.
      const text = answer === undefined ? 'The user did not answer.' : multiSelect ? JSON.parse(answer).join(', ') : answer;
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  // Registered last: the adapter looks for it to know everything above ran.
  pi.registerCommand(${JSON.stringify(SWITCH_EXTENSION_COMMAND)}, {
    description: 'Marks a session run by Switch',
    handler: async () => {},
  });
}
`;

/** Where {@link writeSwitchExtension} puts the extension. */
export const SWITCH_EXTENSION_FILE = 'switch-extension.mjs';

/**
 * Installs the extension in `directory`, which is Switch's own and not Pi's:
 * nothing is written to the person's Pi configuration or the project, so the
 * extension exists only for the sessions Switch starts. Returns its path.
 */
export async function writeSwitchExtension(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SWITCH_EXTENSION_FILE);
  await writeFile(path, SWITCH_EXTENSION_SOURCE, { mode: 0o600 });
  return path;
}

/** Writes the settings the extension reads, for `SWITCH_EXTENSION_CONFIG_ENV` to name. */
export async function writeSwitchExtensionConfig(
  directory: string,
  config: SwitchExtensionConfig
): Promise<string> {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

/**
 * Pi expands `$NAME` and `${NAME}` in an MCP server's `env` and `headers`, and
 * runs a value that starts with `!` as a command. Switch's values are plain
 * text (a bearer token, a path), so they are written so Pi reads them as they
 * are: `$` doubled, and a leading `!` as `$!`.
 */
function literal(value: string): string {
  const doubled = value.replace(/\$/g, () => '$$');
  return doubled.startsWith('!') ? `$${doubled}` : doubled;
}

const literals = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, literal(value)]));

/**
 * The session's MCP servers in the shape of an entry in Pi's `mcp.json`. A
 * stdio server's `envVars` are filled from the session environment, under its
 * explicit `env`.
 */
export function piMcpServers(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.transport === 'stdio'
        ? {
            command: server.command,
            args: server.args,
            env: literals({
              ...Object.fromEntries(
                (server.envVars ?? [])
                  .filter((key) => env[key] !== undefined)
                  .map((key) => [key, env[key]!])
              ),
              ...server.env,
            }),
          }
        : { url: server.url, headers: literals(server.headers ?? {}) },
    ])
  );
}
