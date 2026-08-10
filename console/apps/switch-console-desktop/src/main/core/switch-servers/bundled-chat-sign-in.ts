import { LOCAL_SERVER_MATTERMOST_USER } from '@main/core/managed-switch-server/constants';
import { managedServerSecretsKey } from '@main/core/managed-switch-server/host/host-for-server';
import { readSecrets } from '@main/core/managed-switch-server/secrets';
import { mattermostOriginFor } from '@main/core/switch-rooms/mattermost-origin';
import type { BundledChatSignIn, SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Resolve how a user signs in to a managed deployment's bundled Mattermost.
 *
 * Both halves come from what this deployment actually runs, never from the
 * defaults the docs quote: the origin is built from the host port Switch Console
 * chose and persisted for *this* stack, and the password is the generated one
 * in Switch Console's encrypted store.
 *
 * That store — not the `.env` docker reads — is the source of truth. The env
 * file is rendered *from* the store at every start, and for a remote-managed
 * stack it lives on the remote host, so reading it would be both second-hand
 * and unreachable. It is also the same pair the inline chat pane already logs
 * in with, so what this shows is credentials Switch Console is demonstrably using.
 *
 * Every failure resolves to `unavailable` with a reason rather than throwing or
 * substituting a default: a wrong-but-plausible password sends the user round a
 * login loop with nothing to blame.
 */
export async function bundledChatSignInFor(
  server: SwitchServer | null
): Promise<BundledChatSignIn> {
  if (!server) {
    return {
      kind: 'unavailable',
      reason: 'This server is no longer registered in Switch Console.',
    };
  }
  if (!server.managed) {
    return {
      kind: 'unavailable',
      reason:
        'Switch Console does not run this server, so its chat is someone else’s deployment and Switch Console holds no sign-in for it.',
    };
  }

  const origin = await mattermostOriginFor(server.id);
  if (!origin) {
    return {
      kind: 'unavailable',
      reason:
        'Switch Console has not started this deployment yet, so it has not chosen the port its chat is published on.',
    };
  }

  const secrets = await readSecrets({ secretsKey: managedServerSecretsKey(server) });
  if (!secrets) {
    return {
      kind: 'unavailable',
      reason:
        'Switch Console has no stored credentials for this deployment. They are generated the first time it starts.',
    };
  }

  const password = secrets.mattermostUserPassword;
  if (typeof password !== 'string' || password === '') {
    return {
      kind: 'unavailable',
      reason:
        'The stored credentials for this deployment have no chat password. Resetting the server regenerates them.',
    };
  }

  return {
    kind: 'available',
    url: origin,
    username: LOCAL_SERVER_MATTERMOST_USER,
    password,
  };
}
