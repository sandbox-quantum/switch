import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerSpec } from '../adapter';

/**
 * The variable the session host hands the extension its session in. The
 * extension reads it once and removes it, so no command the agent runs
 * inherits it: it holds the bearer tokens of the session's MCP servers.
 */
export const PI_SESSION_ENV = 'SWITCH_PI_SESSION';

/** What the extension says once its session has started, so the host knows the gate is in place. */
export const PI_READY = 'switch-session-ready';

/** The tag on every question the extension asks the host about a tool call. */
export const PI_TOOL_CALL = 'switch-tool-call';

export const PI_ALLOW = 'allow';
export const PI_BLOCK = 'block';

/** What the extension sends about a tool call, as the title of its `select` request. */
export interface PiToolCallQuestion {
  switch: typeof PI_TOOL_CALL;
  toolCallId: string;
  toolName: string;
  input: unknown;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } | null;
}

export interface PiSessionConfig {
  mcpServers: Record<string, Record<string, unknown>>;
}

/**
 * Switch's extension for Pi, as the file the session host writes for each
 * session and loads with `pi --mode rpc -e`. Nothing is installed in Pi's own
 * folders, so the user's Pi configuration is the same before and after.
 *
 * It registers the session's MCP servers for this session only, and asks the
 * host about every tool call through Pi's extension UI protocol (a `select`
 * the host answers on stdin). Only an explicit allow runs the call: a refusal,
 * a cancelled question or a failing handler blocks it, the last because Pi
 * blocks a tool whose `tool_call` handler throws. Which calls need a person
 * is decided by the host, not here.
 */
export const PI_EXTENSION_SOURCE = `// Written by the Switch session host for one Pi session; see pi/extension.ts in Switch Console.
export default function switchSession(pi) {
  const raw = process.env.${PI_SESSION_ENV};
  delete process.env.${PI_SESSION_ENV};
  if (!raw) throw new Error('${PI_SESSION_ENV} is not set: this extension is loaded by the Switch session host.');
  const session = JSON.parse(raw);
  for (const [name, server] of Object.entries(session.mcpServers)) pi.registerMcpServer(name, server);
  pi.on('session_start', (_event, ctx) => ctx.ui.notify('${PI_READY}', 'info'));
  pi.on('tool_call', async (event, ctx) => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
    const question = {
      switch: '${PI_TOOL_CALL}',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      annotations: tool?.annotations ?? null,
    };
    const answer = await ctx.ui.select(JSON.stringify(question), ['${PI_ALLOW}', '${PI_BLOCK}']);
    if (answer === '${PI_ALLOW}') return undefined;
    return {
      block: true,
      reason:
        answer === '${PI_BLOCK}'
          ? 'Declined in Switch. Stop here and wait for the person to say how to go on; do not do this another way.'
          : 'Cancelled before anyone answered.',
    };
  });
}
`;

/**
 * A literal value as Pi's MCP configuration reads it. Pi expands `$NAME` and
 * `${NAME}` in env and header values and runs a value that starts with `!` as
 * a shell command; `$$` and a leading `$!` are its escapes for the characters
 * themselves.
 */
export function piLiteral(value: string): string {
  const escaped = value.replaceAll('$', '$$$$');
  return escaped.startsWith('!') ? `$!${escaped.slice(1)}` : escaped;
}

function literals(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, piLiteral(value)]));
}

/**
 * The session's MCP servers as `pi.registerMcpServer` takes them. Every tool
 * is declared to the model (`direct`): Pi's default leaves MCP tools to
 * codemode scripts, where the model would have to look for the Switch tools.
 * A stdio server's `envVars` are filled from the session environment, under
 * its explicit `env`.
 */
export function piMcpServers(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): PiSessionConfig['mcpServers'] {
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
            exposure: 'direct',
          }
        : { url: server.url, headers: literals(server.headers ?? {}), exposure: 'direct' },
    ])
  );
}

/**
 * A folder of the session's own holding the extension and the system context
 * Pi appends to its prompt. Removed when the session ends.
 */
export async function writePiSessionFiles(systemContext: string): Promise<{
  dir: string;
  extension: string;
  systemPrompt: string | null;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'switch-pi-'));
  try {
    const extension = join(dir, 'switch-session.js');
    await writeFile(extension, PI_EXTENSION_SOURCE, { mode: 0o600 });
    let systemPrompt: string | null = null;
    if (systemContext) {
      systemPrompt = join(dir, 'switch-context.md');
      await writeFile(systemPrompt, systemContext, { mode: 0o600 });
    }
    return { dir, extension, systemPrompt };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
