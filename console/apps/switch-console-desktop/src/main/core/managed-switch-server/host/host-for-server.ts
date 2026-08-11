import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerDir, remoteServerStateDir } from '../paths';
import { hostSlug, remoteSecretsKey } from './remote-identity';

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

/**
 * The on-disk state directory holding a managed server's persisted port
 * choice. Like {@link managedServerSecretsKey}, this exists so a caller that
 * only needs to read state does not have to construct a {@link ServerHost} —
 * which for a remote server would open an SSH connection.
 */
export function managedServerStateDir(server: SwitchServer): string {
  if (server.managementKind === 'remote' && server.sshHost) {
    return remoteServerStateDir(hostSlug(server.sshHost));
  }
  return localServerDir();
}
