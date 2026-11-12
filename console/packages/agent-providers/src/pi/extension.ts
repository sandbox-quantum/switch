import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerSpec } from '../adapter';

/** The title of the dialog the Switch extension opens before every tool call. */
export const PI_TOOL_CALL_DIALOG = 'switch:tool_call';

/** The environment variable naming the file the Switch extension reads its session from. */
export const PI_SESSION_ENV = 'SWITCH_PI_SESSION';

/** Where the extension keeps the session it read, in Pi's process, for a reload of its extensions. */
export const PI_SESSION_KEY = 'switch.pi.session';

/**
 * The Pi extension every Switch session loads with `-e`, as ESM source. It
 * registers the session's MCP servers and asks the adapter about every tool
 * call through an extension dialog, which RPC mode forwards as an
 * `extension_ui_request`. Anything but a yes blocks the call: a dismissed
 * dialog, an aborted turn (the dialog is tied to the turn's signal) and a
 * handler that throws all do. When the session file cannot be read the
 * extension fails to load, and Pi refuses to start.
 *
 * The session file holds the MCP servers' credentials. It is read once, then
 * deleted and its variable removed from Pi's environment, which Pi's commands
 * and MCP servers inherit; a reload uses what was read.
 */
export const PI_EXTENSION_SOURCE = `import { readFileSync, rmSync } from 'node:fs';

const SESSION = Symbol.for('${PI_SESSION_KEY}');

function readSession() {
  const path = process.env.${PI_SESSION_ENV};
  if (!path) throw new Error('${PI_SESSION_ENV} is not set.');
  const session = JSON.parse(readFileSync(path, 'utf8'));
  rmSync(path);
  delete process.env.${PI_SESSION_ENV};
  return session;
}

export default function switchSession(pi) {
  if (typeof pi.registerMcpServer !== 'function')
    throw new Error('Switch needs a Pi that can register MCP servers (0.99 or later).');
  globalThis[SESSION] ??= readSession();
  const { mcpServers } = globalThis[SESSION];
  for (const [name, config] of Object.entries(mcpServers)) pi.registerMcpServer(name, config);
  pi.on('tool_call', async (event, ctx) => {
    const call = { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input };
    const allowed = await ctx.ui.confirm('${PI_TOOL_CALL_DIALOG}', JSON.stringify(call), {
      signal: ctx.signal,
    });
    if (allowed !== true) return { block: true, reason: 'The user did not allow this tool call.' };
  });
}
`;

/** An `mcpServers` entry as Pi's `mcp.json` and `pi.registerMcpServer` take it. */
export type PiMcpServer =
  | { command: string; args: string[]; env?: Record<string, string>; exposure: 'direct' }
  | { url: string; headers?: Record<string, string>; exposure: 'direct' };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * A value Pi reads literally. Pi expands `$NAME` and `${NAME}` in an MCP
 * server's `env` and `headers`, and runs a value starting with `!` as a shell
 * command; `$$` and `$!` are its escapes for the two characters.
 */
export function piLiteral(value: string): string {
  const escaped = value.replaceAll('$', () => '$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

function literals(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, piLiteral(value)])
  );
}

/**
 * The session's MCP servers as the Switch extension registers them, each
 * declared to the model directly: Pi's default exposure reaches a server's
 * tools only from codemode scripts. A stdio server inherits Pi's environment,
 * so the variables the session passes it by name (`envVars`) reach it.
 */
export function piMcpServers(specs: Record<string, McpServerSpec>): Record<string, PiMcpServer> {
  const servers: Record<string, PiMcpServer> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!SERVER_NAME.test(name))
      throw new Error(`Pi cannot take an MCP server named ${name}: only letters, digits, _ and -.`);
    servers[name] =
      spec.transport === 'stdio'
        ? {
            command: spec.command,
            args: spec.args,
            ...(spec.env ? { env: literals(spec.env) } : {}),
            exposure: 'direct',
          }
        : {
            url: spec.url,
            ...(spec.headers ? { headers: literals(spec.headers) } : {}),
            exposure: 'direct',
          };
  }
  return servers;
}

/** The prefix Pi gives an MCP server's tools: `mcp__<server>__`, `-` read as `_`. */
export function piMcpToolPrefix(server: string): string {
  return `mcp__${server.replaceAll('-', '_')}__`;
}

/**
 * Refuses a session whose MCP server the user's own Pi configuration would
 * replace or pass for: a server in `mcp.json` takes precedence over one an
 * extension registers under the same name, and one named `<name>__…` has
 * tools named like the session server's, which run without asking. Both
 * files are read, the project's whether or not Pi trusts the project.
 */
export async function assertNoShadowingServers(
  names: readonly string[],
  cwd: string,
  env: Record<string, string>
): Promise<void> {
  const agentDir =
    env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[/\\])/, env.HOME || homedir()) ||
    join(env.HOME || homedir(), '.pi', 'agent');
  for (const file of [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
      throw new Error(`Pi's ${file} is not valid JSON: ${String(error)}`, { cause: error });
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    const configured = servers && typeof servers === 'object' ? Object.keys(servers) : [];
    for (const name of names) {
      const shadow = configured.find((other) =>
        piMcpToolPrefix(other).startsWith(piMcpToolPrefix(name))
      );
      if (shadow !== undefined)
        throw new Error(
          `${file} defines an MCP server named ${shadow}, which Pi would take for the session's ${name} server. Rename or remove it there.`
        );
    }
  }
}
