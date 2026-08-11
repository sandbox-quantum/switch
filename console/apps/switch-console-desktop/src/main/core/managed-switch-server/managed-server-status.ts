import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import type { LocalServerPhase } from '@shared/core/managed-switch-server/managed-switch-server';
import { type HostReachability, isHostBlocked } from '@shared/core/remote-hosts/reachability';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerService } from './local-server-service';
import { remoteServerService } from './remote-server-service';

/**
 * Whether a Switch Console-managed server's stack is currently running — i.e. its
 * lifecycle phase is `running`. Routes to the right supervisor the same way
 * {@link managedServerSecretsKey} does: a remote-managed server reads its
 * per-host status; everything else (local, or a legacy managed row with a null
 * kind) reads the single local status. Both services reconcile the real stack
 * state at boot (`initialize()`), so the phase is authoritative.
 *
 * Only meaningful for managed servers; returns `false` for external
 * (non-managed) ones, so callers can gate a would-be network call on it without
 * separately checking `server.managed`.
 */
export function isManagedServerRunning(server: SwitchServer): boolean {
  if (!server.managed) return false;
  if (server.managementKind === 'remote') {
    if (server.sshHost === null) return false;
    // A `running` phase describes containers we last saw up on the far side of
    // an SSH tunnel. If the host is unreachable that phase is stale — the
    // forward is dead and nothing on it can be reached — so reachability is
    // folded in here rather than persisted as a separate phase, keeping one
    // source of truth and making recovery automatic (CHOO-1780).
    if (hostReachabilityService.isBlocked(server.sshHost)) return false;
    return remoteServerService.getStatus(server.sshHost).phase === 'running';
  }
  return localServerService.getStatus().phase === 'running';
}

/**
 * The blocked reachability record for a remote-managed server's host, or null
 * when the host is fine (or the server isn't remote-managed). Callers use this
 * to report one honest host-level state instead of a downstream transport
 * error.
 */
export function managedServerHostBlocked(server: SwitchServer): HostReachability | null {
  if (!server.managed || server.managementKind !== 'remote' || server.sshHost === null) return null;
  const reachability = hostReachabilityService.get(server.sshHost);
  return isHostBlocked(reachability) ? reachability : null;
}

/**
 * The phase of a managed server's stack when it is settled on *not serving*, or
 * null when a call to it may legitimately be attempted.
 *
 * Only `stopped` and `error` count. `starting` and `stopping` are transitions —
 * the stack that is coming up is reached through exactly these calls (the boot
 * sequence registers and signs in while the phase is still `starting`), so
 * gating on "not running" rather than "settled not running" would block the
 * very work that makes it running.
 *
 * A remote-managed server whose host is blocked returns null: that is the
 * host's state to report, via {@link managedServerHostBlocked}, and a phase
 * read across a dead SSH forward is stale anyway.
 */
export function managedServerStoppedPhase(server: SwitchServer): LocalServerPhase | null {
  if (!server.managed) return null;
  let phase: LocalServerPhase;
  if (server.managementKind === 'remote') {
    if (server.sshHost === null || hostReachabilityService.isBlocked(server.sshHost)) return null;
    phase = remoteServerService.getStatus(server.sshHost).phase;
  } else {
    phase = localServerService.getStatus().phase;
  }
  return phase === 'stopped' || phase === 'error' ? phase : null;
}
