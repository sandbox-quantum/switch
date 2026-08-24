import { randomUUID } from 'node:crypto';
import { KV } from '@main/db/kv';

/**
 * Deliberately not `telemetry:instanceId`, which the telemetry stack removed in
 * CHOO-1370 wrote and no migration ever scrubbed: that row is still in the
 * database of every install predating the removal, and reusing it would carry
 * an identifier forward out of a system users were told had been taken out.
 */
const store = new KV<{ installId: string }>('telemetry');

let pending: Promise<string> | null = null;

/**
 * A random id for this installation, created on first use and kept in the local
 * database.
 *
 * It is what lets two events be recognised as coming from the same copy of the
 * app — which is the whole difference between counting events and counting
 * users. It is random: nothing about it is derived from the machine, the user
 * account, the network, or any Switch identity, and it is never sent anywhere
 * but Amplitude, alongside the events in `./events`.
 *
 * Because it makes the data pseudonymous rather than anonymous, it is the
 * reason consent is opt-in. Deleting the app's data directory produces a new
 * one; there is deliberately no way to correlate the two.
 */
export async function getInstallId(): Promise<string> {
  pending ??= load().catch((error: unknown) => {
    // A failed write must not poison every later send with a rejected promise.
    pending = null;
    throw error;
  });
  return pending;
}

async function load(): Promise<string> {
  const existing = await store.get('installId');
  if (existing) return existing;

  const created = randomUUID();
  await store.setOrThrow('installId', created);
  return created;
}
