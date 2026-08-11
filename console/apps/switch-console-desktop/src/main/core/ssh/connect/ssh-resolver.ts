import { sshConnectionManager } from '@main/core/ssh/lifecycle/production-ssh-connection-manager';
import { resolveSshConnectConfig } from './resolve-ssh-connect-config';

/**
 * Register the per-id config resolver (the host's `~/.ssh/config` alias →
 * ssh2 ConnectConfig). Lives apart from `connect-agent-ssh` so the reachability
 * probe can rebuild a transport without importing the reachability-gated
 * connect helpers that consume it.
 *
 * host/port/username in the transient config are fallbacks: the real values
 * (and identity/agent) are resolved from the alias via `ssh -G`. Auth goes
 * through the SSH agent — Switch Console stores no credentials of its own.
 */
export function registerSshResolver(connectionId: string, sshHost: string): void {
  sshConnectionManager.register(connectionId, () =>
    resolveSshConnectConfig({
      kind: 'transient',
      config: {
        name: sshHost,
        host: sshHost,
        port: 22,
        username: '',
        sshConfigAlias: sshHost,
        authType: 'agent',
      },
    })
  );
}
