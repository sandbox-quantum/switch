import { randomUUID } from 'node:crypto';
import { KV } from '@main/db/kv';
import { TELEMETRY_ID_LIFETIME_DAYS } from '@shared/core/telemetry/identifier';

export const INSTALL_ID_LIFETIME_MS = TELEMETRY_ID_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

/** The id and when it was minted, in epoch milliseconds. */
type StoredInstallId = { id: string; createdAt: number };

/**
 * Deliberately not `telemetry:instanceId`, which the telemetry stack removed in
 * CHOO-1370 wrote and no migration ever scrubbed: that row is still in the
 * database of every install predating the removal, and reusing it would carry
 * an identifier forward out of a system users were told had been taken out.
 *
 * Builds before the id rotated stored a bare string under the same key. It has
 * no creation time, so it reads as expired and is replaced by the next send.
 */
const store = new KV<{ installId: StoredInstallId | string }>('telemetry');

/** `undefined` until the store has been read; `null` when it holds no usable id. */
let known: StoredInstallId | null | undefined;

let queue: Promise<unknown> = Promise.resolve();

/**
 * One read-or-write at a time, so that callers asking at the same moment get one
 * id rather than racing to mint several, and so that forgetting the id cannot
 * interleave with minting it.
 */
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function usable(value: StoredInstallId | string | null): StoredInstallId | null {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !Number.isFinite(value.createdAt)) return null;
  return value;
}

/** A creation time in the future means the clock moved; the id's age is unknowable, so it goes. */
function isCurrent(entry: StoredInstallId, nowMs: number): boolean {
  return entry.createdAt <= nowMs && nowMs - entry.createdAt < INSTALL_ID_LIFETIME_MS;
}

/**
 * The random id usage data is sent under, minted when first needed and replaced
 * once it is {@link TELEMETRY_ID_LIFETIME_DAYS} days old.
 *
 * It is what lets events from the same copy of the app be grouped, which is the
 * difference between counting events and counting installations. It is random:
 * nothing about it is derived from the machine, the user account, the network,
 * or any Switch identity, and it goes nowhere but the telemetry relay, which
 * forwards it to Amplitude as the device id.
 *
 * It is a pseudonymous identifier, not an anonymous one: while it lasts, it
 * links that installation's events together. Rotation bounds the link to one
 * {@link TELEMETRY_ID_LIFETIME_DAYS}-day window. The old id is overwritten, not
 * kept, so nothing on this machine or in the payload connects one window to the
 * next. Rotation is lazy — checked each time an event is about to be sent — so
 * an id can be older than that only for as long as nothing has been sent.
 *
 * Call it only once consent has been checked: it writes the id it returns.
 */
export function getInstallId(): Promise<string> {
  return serialised(async () => {
    if (known === undefined) known = usable(await store.get('installId'));

    const nowMs = Date.now();
    if (known && isCurrent(known, nowMs)) return known.id;

    const fresh: StoredInstallId = { id: randomUUID(), createdAt: nowMs };
    await store.setOrThrow('installId', fresh);
    known = fresh;
    return fresh.id;
  });
}

/**
 * Delete the stored id, so that sharing turned back on later starts under a new
 * one with nothing linking it to the old.
 *
 * Throws when the delete fails: an opt-out that leaves the id behind must be
 * visible, not assumed done.
 */
export function forgetInstallId(): Promise<void> {
  return serialised(async () => {
    known = undefined;
    await store.delOrThrow('installId');
    known = null;
  });
}
