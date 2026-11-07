import type { ProviderSessionStartInput } from '../adapter';

/** A variable whose name says its value is a credential. */
const SECRET_VARIABLE =
  /(?:^|[_-])(?:token|secret|password|passwd|passphrase|credentials?|api[_-]?key|private[_-]?key|access[_-]?key)$/i;
/** A header that carries a credential. */
const SECRET_HEADER = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;
const AUTH_SCHEME = /^(?:bearer|basic|bot|token)\s+/i;

// Shorter values are too likely to be ordinary text, which masking every
// occurrence of would wreck. A credential from an authentication header is
// known to be one, so it is taken from a shorter length.
const VARIABLE_MIN = 8;
const HEADER_MIN = 6;

/**
 * The secrets a host hands a session, to mask wherever the session's tool
 * calls are shown: the value of each secret-named variable in the agent's
 * environment and its MCP servers', and the credential in each MCP server's
 * authentication header, with and without its scheme.
 */
export function handedSecrets(
  input: Pick<ProviderSessionStartInput, 'env' | 'mcpServers'>
): string[] {
  const secrets: string[] = [];
  const fromVariables = (env: Record<string, string> | undefined) => {
    for (const [name, value] of Object.entries(env ?? {}))
      if (SECRET_VARIABLE.test(name) && value.length >= VARIABLE_MIN) secrets.push(value);
  };
  fromVariables(input.env);
  for (const server of Object.values(input.mcpServers)) {
    if (server.transport === 'stdio') {
      fromVariables(server.env);
      continue;
    }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      if (!SECRET_HEADER.test(name)) continue;
      const credential = value.replace(AUTH_SCHEME, '');
      if (credential.length < HEADER_MIN) continue;
      secrets.push(value);
      if (credential !== value) secrets.push(credential);
    }
  }
  return secrets;
}
