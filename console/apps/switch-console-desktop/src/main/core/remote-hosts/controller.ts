import { evictRemoteDependencyManager } from '@main/core/dependencies/remote-dependency-manager';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import { hostKeyTrustService } from '@main/core/ssh/host-keys/production-host-keys';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { hostBlockedReason, type HostReachability } from '@shared/core/remote-hosts/reachability';
import type { HostSetupPlan } from '@shared/core/remote-hosts/setup';
import type { HostKeyProblem } from '@shared/core/ssh/host-keys';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { listSshConfigHosts } from './list-ssh-config-hosts';
import { hostReachabilityService, releaseHostIfUnused } from './production-host-reachability';
import {
  discardSetupPlan,
  ensureSetupPlan,
  installSetupStep,
  readAllSetupPlans,
  readSetupPlan,
  recheckSetup,
  recheckSetupStep,
  skipSetupStep,
  updateSetupStep,
} from './setup/host-setup-service';
import { listRemoteHosts, removeRemoteHost, upsertRemoteHost, type RemoteHost } from './store';

export type TestConnectionResult = { ok: true } | { ok: false; message: string };

/**
 * Probe now. If the host's key is refused and the user can decide about it —
 * the prompt for it is already up — wait for the answer, and probe again once
 * they trust it, so an explicit check carries on rather than failing under the
 * prompt.
 */
async function checkNowDecidingHostKey(sshHost: string): Promise<HostReachability> {
  const reachability = await hostReachabilityService.checkNow(sshHost);
  if (reachability.status !== 'untrusted') return reachability;
  const decision = hostKeyTrustService.waitForDecision(sshHost);
  if (!decision || (await decision) !== 'trusted') return hostReachabilityService.get(sshHost);
  return hostReachabilityService.checkNow(sshHost);
}

/**
 * Ad-hoc reachability check. Routed through the reachability service rather
 * than connecting directly, so a manual "Test connection" and the background
 * probe share one code path — and a successful test immediately un-pauses the
 * host-dependent work that was gated on the old state.
 */
async function testConnection(sshHost: string): Promise<TestConnectionResult> {
  hostKeyTrustService.clearDismissals(sshHost);
  const reachability = await checkNowDecidingHostKey(sshHost);
  if (reachability.status === 'reachable') return { ok: true };
  return { ok: false, message: reachability.lastError ?? hostBlockedReason(reachability) };
}

export const remoteHostsController = createRPCController({
  /** SSH aliases from ~/.ssh/config, for the onboarding picker. */
  listSshConfigHosts: (): Promise<string[]> => listSshConfigHosts(),

  /** Onboarded remote hosts. */
  listHosts: (): Promise<RemoteHost[]> => listRemoteHosts(),

  /** Every host the reachability model knows about, for the initial UI hydrate. */
  listReachability: (): Promise<HostReachability[]> =>
    Promise.resolve(hostReachabilityService.getAll()),

  /**
   * Probe now, bypassing the backoff — the "Retry connection" button. On
   * success this clears the blocked state, which resumes every paused
   * host-dependent path (reconciler included) rather than only fixing the
   * screen the user is looking at.
   */
  retryHost: (sshHost: string): Promise<HostReachability> => {
    // An explicit retry asks again about a host key the user turned down.
    hostKeyTrustService.clearDismissals(sshHost);
    return checkNowDecidingHostKey(sshHost);
  },

  /** Host keys refused and waiting for the user, for the renderer's hydrate. */
  listHostKeyProblems: (): Promise<HostKeyProblem[]> => Promise.resolve(hostKeyTrustService.list()),

  /**
   * Trust the key a host presented — the one whose fingerprint the user was
   * shown — then reconnect, which resumes the host's paused work.
   */
  trustHostKey: async (params: {
    sshHost: string;
    fingerprint: string;
  }): Promise<HostReachability> => {
    await hostKeyTrustService.trust(params.sshHost, params.fingerprint);
    return hostReachabilityService.checkNow(params.sshHost);
  },

  /** Turn a host key down. The host stays blocked until the user retries. */
  dismissHostKey: (params: { sshHost: string; fingerprint: string }): Promise<void> => {
    hostKeyTrustService.dismiss(params.sshHost, params.fingerprint);
    return Promise.resolve();
  },

  /** Verify reachability, then onboard (or rename) the host. */
  onboardHost: async (params: {
    sshHost: string;
    name: string;
    /**
     * Whether the alias came from the machine's SSH config or was typed in. Only
     * the form knows — both write through here — and it is the difference
     * between a host the app offered and one someone had to know the name of.
     */
    pickedFromSshConfig: boolean;
  }): Promise<RemoteHost> => {
    const test = await testConnection(params.sshHost);
    if (!test.ok) {
      trackEvent('host_onboarded', {
        outcome: 'failure',
        picked_from_ssh_config: params.pickedFromSshConfig === true,
      });
      throw new Error(`Cannot reach ${params.sshHost}: ${test.message}`);
    }
    const host = await upsertRemoteHost({ sshHost: params.sshHost, name: params.name });
    trackEvent('host_onboarded', {
      outcome: 'success',
      picked_from_ssh_config: params.pickedFromSshConfig === true,
    });
    return host;
  },

  /**
   * Remove a host and everything keyed to it. Previously only the row was
   * deleted, leaving an orphaned reachability record and a cached dependency
   * manager bound to the old connection — so re-adding the same alias resumed
   * against stale state.
   */
  removeHost: async (sshHost: string): Promise<void> => {
    try {
      // Its agent controllers are revoked first: a host Console forgets would
      // otherwise go on running agents with nothing left here to stop them.
      await hostControllerService.forgetHost(sshHost);
      await removeRemoteHost(sshHost);
      await discardSetupPlan(sshHost);
      await hostReachabilityService.reset(sshHost);
      await releaseHostIfUnused(sshHost);
      evictRemoteDependencyManager(sshHost);
    } catch (error) {
      trackEvent('host_removed', { outcome: 'failure' });
      throw error;
    }
    trackEvent('host_removed', { outcome: 'success' });
  },

  /** The host's persisted setup plan, or null if setup has never been run. */
  getSetupPlan: (sshHost: string): Promise<HostSetupPlan | null> => readSetupPlan(sshHost),

  /** Every host's plan, for the initial hydrate of the renderer's readiness store. */
  listSetupPlans: (): Promise<HostSetupPlan[]> => readAllSetupPlans(),

  /**
   * Build or refresh the plan without running it — what the host page loads on
   * open. Merges onto any persisted progress rather than discarding it.
   * Structural only: it lists what to check, it does not check it.
   */
  prepareSetup: (sshHost: string): Promise<HostSetupPlan> => ensureSetupPlan(sshHost),

  /** Probe every step and install nothing — the "Re-check" button. */
  recheckSetup: (sshHost: string): Promise<HostSetupPlan> => recheckSetup(sshHost),

  /** Re-observe one prerequisite or agent type, installing nothing. */
  recheckSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    recheckSetupStep(params.sshHost, params.stepId),

  /** Install one prerequisite or agent type on its own, then verify it. */
  installSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    installSetupStep(params.sshHost, params.stepId),

  /** Replace one prerequisite or agent type with its newest version, then verify. */
  updateSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    updateSetupStep(params.sshHost, params.stepId),

  /** Move past a step the user has chosen not to fix, unblocking the rest. */
  skipSetupStep: (params: { sshHost: string; stepId: string }): Promise<HostSetupPlan> =>
    skipSetupStep(params.sshHost, params.stepId),
});
