import type { McpServerSpec } from '../adapter';

/** TOML bare keys; anything else would have to be quoted inside a `-c` dotted path. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`
  );
  return `{ ${entries.join(', ')} }`;
}

/**
 * `codex app-server` reads MCP servers from config, so a per-session
 * registration is a set of `-c mcp_servers.<name>.<key>=<toml>` overrides on
 * the process it is spawned with.
 */
export function mcpServerConfigArgs(servers: Record<string, McpServerSpec>): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (!BARE_KEY.test(name)) {
      throw new Error(
        `MCP server name ${JSON.stringify(name)} cannot be expressed as a Codex config key; use letters, digits, underscore or dash`
      );
    }
    const prefix = `mcp_servers.${name}`;
    const push = (key: string, value: string) => {
      args.push('-c', `${prefix}.${key}=${value}`);
    };
    if (spec.transport === 'stdio') {
      push('command', tomlString(spec.command));
      push('args', tomlStringArray(spec.args));
      if (spec.envVars?.length) push('env_vars', tomlStringArray(spec.envVars));
      if (spec.env && Object.keys(spec.env).length > 0) push('env', tomlStringTable(spec.env));
    } else {
      push('url', tomlString(spec.url));
      // A bearer token goes to Codex by the name of the variable holding it
      // (`bearer_token_env_var`), so the secret is in the app-server's
      // environment rather than on its command line, where any user on the
      // machine can read it.
      const headers = { ...spec.headers };
      const authorization = Object.keys(headers).find(
        (header) => header.toLowerCase() === 'authorization'
      );
      const bearer = authorization ? /^Bearer (.+)$/.exec(headers[authorization]!) : null;
      if (authorization && bearer) {
        const variable = `SWITCH_MCP_${name.toUpperCase().replace(/-/g, '_')}_BEARER_TOKEN`;
        env[variable] = bearer[1]!;
        delete headers[authorization];
        push('bearer_token_env_var', tomlString(variable));
      }
      if (Object.keys(headers).length > 0) push('http_headers', tomlStringTable(headers));
    }
    push('default_tools_approval_mode', tomlString('approve'));
  }
  return { args, env };
}

/** `--enable`/`--disable` pairs for the app-server feature flags a session needs. */
export function featureArgs(features: Record<string, boolean>): string[] {
  return Object.entries(features).flatMap(([name, enabled]) => [
    enabled ? '--enable' : '--disable',
    name,
  ]);
}
