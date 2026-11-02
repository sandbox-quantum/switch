import { isSecretName } from '@switch-console/shared/redact-secrets';
import type { McpServerSpec, ProviderSessionStartInput } from '../adapter';

/**
 * The credentials a host hands the agent it starts, for the session's
 * redaction list: what the agent and its MCP servers are given, so a tool that
 * prints its environment or a request it made shows none of them.
 *
 * - an MCP server's credential-named headers (`Authorization` and the like),
 *   whole and without the scheme in front;
 * - a stdio MCP server's credential-named environment, set or forwarded;
 * - the agent's own credential-named environment.
 *
 * A value shorter than `MIN_SECRET` is left out: a short value is a flag or a
 * port, and masking it would mask every occurrence of it in what a tool says.
 */
export const MIN_SECRET = 8;

type Started = Pick<ProviderSessionStartInput, 'env' | 'mcpServers'>;

function named(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && isSecretName(name) ? [value] : []
  );
}

function fromServer(spec: McpServerSpec, hostEnv: NodeJS.ProcessEnv): string[] {
  if (spec.transport === 'http')
    return Object.entries(spec.headers ?? {}).flatMap(([name, value]) => {
      if (!isSecretName(name)) return [];
      // `Bearer <token>` is also written as the token alone.
      const scheme = /^[A-Za-z]+\s+(\S+)$/.exec(value);
      return scheme ? [value, scheme[1]!] : [value];
    });
  return [
    ...named(spec.env ?? {}),
    ...named(Object.fromEntries((spec.envVars ?? []).map((name) => [name, hostEnv[name]]))),
  ];
}

export function handedSecrets(started: Started, hostEnv: NodeJS.ProcessEnv): string[] {
  const secrets = [
    ...named(started.env),
    ...Object.values(started.mcpServers).flatMap((spec) => fromServer(spec, hostEnv)),
  ];
  return [...new Set(secrets.filter((secret) => secret.length >= MIN_SECRET))];
}
