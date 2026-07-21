import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { remoteSecretsKey } from './remote-identity';

/** Local host's fixed secrets-store key. */
const LOCAL_SECRETS_KEY = 'local-switch-server:secrets';

/**
 * The encrypted-store key holding a managed server's stack secret bundle.
 * Resolves from the server's management kind: the single local key for a
 * local-managed server, or a per-host key for a remote-managed one (so a local
 * stack and any number of remote stacks keep separate credentials). Callers
 * that only need to read the secrets (e.g. silent re-login) use this rather than
 * constructing a full {@link ServerHost} (which, for remote, would open SSH).
 */
export function managedServerSecretsKey(server: SwitchServer): string {
  if (server.managementKind === 'remote' && server.sshHost) {
    return remoteSecretsKey(server.sshHost);
  }
  return LOCAL_SECRETS_KEY;
}
