import { sealingKeyFingerprint, sealingKeyId } from '@switch-console/agent-providers';
import type { HostSealingKey } from '@main/core/host-controllers/host-controller-service';
import type { ManagementController } from '@main/core/switch-servers/gateway-client';
import type { MachineLocal, MachineSealingKey } from '@shared/core/managed-agents/managed-agents';
import type { SealingKeyPins } from './sealing-key-pins';

/** {@link MachineSealingKey} with the key itself, which never leaves the main process. */
export type ResolvedSealingKey =
  | { state: 'verified'; key: string; fingerprint: string; source: 'machine' | 'pinned' }
  | { state: 'first-use'; key: string; fingerprint: string }
  | { state: 'changed'; key: string; fingerprint: string; previousFingerprint: string }
  | { state: 'refused'; reason: string };

export type SealingKeyDeps = {
  pins: SealingKeyPins;
  /** What an SSH host of this Console says its controller's key is, asked over SSH. */
  hostKey: (serverId: string, sshHost: string) => Promise<HostSealingKey>;
  warn: (message: string, fields: Record<string, unknown>) => void;
};

type Machine = Pick<ManagementController, 'id' | 'name' | 'sealingKey'>;

/**
 * The key a login given to `controller` is to be sealed to, never taken on
 * the server's word alone where Console can know better:
 *
 * - this computer's controller keeps no key (it runs on a credential Console
 *   hands it), so any key the server reports for it is refused;
 * - an SSH host of this Console is asked for its key over SSH, and a server
 *   that sends another is refused;
 * - any other machine, or a host that cannot be asked now, is held to the key
 *   Console pinned the first time it sealed a login to it. Switch keeps one
 *   key per controller and enrolling again makes a new controller, so a
 *   pinned machine whose key changes is reported, not followed.
 */
export async function resolveSealingKey(
  deps: SealingKeyDeps,
  serverId: string,
  controller: Machine,
  local: MachineLocal
): Promise<ResolvedSealingKey> {
  const name = controller.name;
  if (local?.kind === 'this-computer')
    return refused(
      `${name} is this computer, whose controller keeps no key for given logins: it signs in with this computer's own sign-ins.${controller.sealingKey ? ' Switch reports a key for it, which is not this computer’s.' : ''}`
    );
  const offered = controller.sealingKey;
  if (!offered)
    return refused(
      `${name} cannot be given a login: its controller has no key for one. Update the controller on it.`
    );
  const fingerprint = fingerprintOf(offered.key);
  if (fingerprint === null || sealingKeyId(offered.key) !== offered.keyId)
    return refused(`The server sent a key for ${name} that is malformed or does not match its id.`);

  if (local?.kind === 'ssh-host') {
    const own = await deps.hostKey(serverId, local.sshHost);
    if (own.kind === 'none')
      return refused(
        `${name} keeps no key for given logins, though Switch reports one for it (${fingerprint}). No login is sealed to a key the machine does not hold.`
      );
    if (own.kind === 'key') {
      if (own.publicKey !== offered.key)
        return refused(
          `Switch sends another key for ${name} (${fingerprint}) than the machine holds (${fingerprintOf(own.publicKey) ?? 'unreadable'}), so no login is sealed to it: whoever holds Switch’s key could open it.`
        );
      const pin = await deps.pins.get(serverId, controller.id);
      if (pin?.key !== own.publicKey) await deps.pins.set(serverId, controller.id, own.publicKey);
      return { state: 'verified', key: own.publicKey, fingerprint, source: 'machine' };
    }
    deps.warn('Could not ask an SSH host for its sealing key; holding it to the pinned one', {
      serverId,
      controllerId: controller.id,
      sshHost: local.sshHost,
      reason: own.reason,
    });
  }

  const pin = await deps.pins.get(serverId, controller.id);
  if (!pin) return { state: 'first-use', key: offered.key, fingerprint };
  if (pin.key === offered.key)
    return { state: 'verified', key: offered.key, fingerprint, source: 'pinned' };
  return {
    state: 'changed',
    key: offered.key,
    fingerprint,
    previousFingerprint: fingerprintOf(pin.key) ?? 'unreadable',
  };
}

/** What the renderer is shown: everything but the key. */
export function sealingKeyView(resolved: ResolvedSealingKey): MachineSealingKey {
  switch (resolved.state) {
    case 'verified':
      return {
        state: 'verified',
        fingerprint: resolved.fingerprint,
        source: resolved.source,
      };
    case 'first-use':
      return { state: 'first-use', fingerprint: resolved.fingerprint };
    case 'changed':
      return {
        state: 'changed',
        fingerprint: resolved.fingerprint,
        previousFingerprint: resolved.previousFingerprint,
      };
    case 'refused':
      return resolved;
  }
}

/**
 * The key to seal a login to, once the user has seen `shownFingerprint`: a
 * changed or refused key throws, and so does a key that changed after it was
 * shown, so what is sealed is always what the user looked at.
 */
export function keyToSealTo(
  name: string,
  resolved: ResolvedSealingKey,
  shownFingerprint: string
): string {
  if (resolved.state === 'refused') throw new Error(resolved.reason);
  if (resolved.state === 'changed')
    throw new Error(
      `Switch now sends another key for ${name} (${resolved.fingerprint}) than the one Console sealed its logins to (${resolved.previousFingerprint}). Check the machine, and trust the new key only if it is the machine’s.`
    );
  if (resolved.fingerprint !== shownFingerprint)
    throw new Error(
      `${name}’s key changed while the login was being given (${resolved.fingerprint}, not ${shownFingerprint}). Look at it again before giving the login.`
    );
  return resolved.key;
}

function refused(reason: string): ResolvedSealingKey {
  return { state: 'refused', reason };
}

function fingerprintOf(key: string): string | null {
  try {
    return sealingKeyFingerprint(key);
  } catch {
    return null;
  }
}
