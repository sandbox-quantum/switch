import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

const pinSchema = z.strictObject({ key: z.string().min(1), pinnedAt: z.string() });

/** The sealing key Console first gave a machine a login sealed to, and when. */
export type SealingKeyPin = z.infer<typeof pinSchema>;

/**
 * Per server and machine, the key provider logins given to it from here are
 * sealed to: pinned the first time, so that a server which later sends
 * another key for the same machine is caught rather than trusted. Kept in
 * Console's own database, which no server writes.
 */
export interface SealingKeyPins {
  get(serverId: string, controllerId: string): Promise<SealingKeyPin | null>;
  set(serverId: string, controllerId: string, key: string): Promise<void>;
}

function pinKey(serverId: string, controllerId: string): string {
  return `sealing-key-pin:${JSON.stringify([serverId, controllerId])}`;
}

export const sealingKeyPins: SealingKeyPins = {
  async get(serverId, controllerId) {
    const [row] = await db
      .select({ value: kv.value })
      .from(kv)
      .where(eq(kv.key, pinKey(serverId, controllerId)))
      .limit(1);
    if (!row) return null;
    // A pin that does not read is not taken for no pin: that would trust the
    // next key the server sends.
    return pinSchema.parse(JSON.parse(row.value));
  },

  async set(serverId, controllerId, key) {
    const value = JSON.stringify({ key, pinnedAt: new Date().toISOString() });
    const now = Date.now();
    await db
      .insert(kv)
      .values({ key: pinKey(serverId, controllerId), value, updatedAt: now })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
  },
};
