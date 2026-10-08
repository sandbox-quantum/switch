import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';

/**
 * The Console agents that were moved onto an agents controller ("Move to
 * managed"), keyed by Console agent id.
 *
 * While an agent is here, Console does not run its watcher: boot, a restored
 * auto-session and a saved setting all leave it to its controller. The record
 * holds what moving it back needs — which identities moved with it and where
 * their credentials were — and nothing secret: a moved agent's credentials
 * file is kept in the encrypted app secrets store until it comes back.
 */
const KEY = 'controller_managed_agents';

const identitySchema = z.object({
  /** The Switch agent id. */
  switchAgentId: z.string().min(1),
  /** The name its credentials file is kept under: `.switch/agents/<slug>.json`. */
  slug: z.string().min(1),
  /** Null for the agent itself; a subagent's name for one watched under it. */
  subagent: z.string().min(1).nullable(),
  /** Whether its credentials file was there and is kept in the secrets store. */
  credentialsStashed: z.boolean(),
  /** The controller's watcher root for it, on the agent's machine (`~/` is that machine's home). */
  controllerRoot: z.string().min(1),
});

export type MovedIdentity = z.infer<typeof identitySchema>;

const placementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('this-computer'), serverId: z.string().min(1) }),
  z.object({
    kind: z.literal('ssh-host'),
    sshHost: z.string().min(1),
    serverId: z.string().min(1),
  }),
]);

export type ManagedPlacementRecord = z.infer<typeof placementSchema>;

const recordSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  controllerId: z.string().min(1),
  placement: placementSchema,
  /** The agent first, then the subagents that moved with it. */
  identities: z.array(identitySchema).min(1),
  movedAt: z.string(),
});

export type ManagedAgentRecord = z.infer<typeof recordSchema>;

async function readAll(): Promise<Record<string, ManagedAgentRecord>> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, KEY));
  if (!row) return {};
  // A record that cannot be read is not "not managed": treating it so would
  // start Console's watcher for an agent its controller runs, and the two
  // would take the agent's connection from each other.
  return z.record(z.string(), recordSchema).parse(JSON.parse(row.value));
}

async function writeAll(records: Record<string, ManagedAgentRecord>): Promise<void> {
  const value = JSON.stringify(records);
  await db
    .insert(appSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

let tail: Promise<unknown> = Promise.resolve();

/** One change at a time: the records share a row, and two overlapping writes would drop one. */
function change(
  update: (records: Record<string, ManagedAgentRecord>) => Record<string, ManagedAgentRecord>
): Promise<void> {
  const next = tail.catch(() => {}).then(async () => writeAll(update(await readAll())));
  tail = next;
  return next;
}

export async function listManagedAgentRecords(): Promise<ManagedAgentRecord[]> {
  await tail.catch(() => {});
  return Object.values(await readAll());
}

export async function getManagedAgentRecord(agentId: string): Promise<ManagedAgentRecord | null> {
  await tail.catch(() => {});
  return (await readAll())[agentId] ?? null;
}

export function setManagedAgentRecord(record: ManagedAgentRecord): Promise<void> {
  const parsed = recordSchema.parse(record);
  return change((records) => ({ ...records, [parsed.agentId]: parsed }));
}

export function deleteManagedAgentRecord(agentId: string): Promise<void> {
  return change((records) => {
    const rest = { ...records };
    delete rest[agentId];
    return rest;
  });
}

/**
 * The moved agent whose watcher Console must leave alone for this Console
 * agent: its own record, or the record of the parent it moved with, matched
 * by Switch identity. Null when Console runs it.
 */
export async function managedRecordFor(
  agentId: string,
  switchAgentId: string | null
): Promise<ManagedAgentRecord | null> {
  const records = await listManagedAgentRecords();
  return (
    records.find((record) => record.agentId === agentId) ??
    (switchAgentId
      ? (records.find((record) =>
          record.identities.some((identity) => identity.switchAgentId === switchAgentId)
        ) ?? null)
      : null)
  );
}

/** Thrown where Console would start the watcher of an agent a controller runs. */
export class AgentManagedByControllerError extends Error {
  constructor(name: string) {
    super(`${name} runs on a managed machine now: Switch runs it there, not this Console.`);
    this.name = 'AgentManagedByControllerError';
  }
}

/** The encrypted app secret a moved identity's credentials are kept under until it comes back. */
export function credentialsStashKey(agentId: string, switchAgentId: string): string {
  return `agent-migration:${agentId}:${switchAgentId}:credentials`;
}

/**
 * Forgets a moved agent Console no longer has: its record and the credentials
 * kept for it. Switch goes on managing it; it is just no longer Console's to
 * bring back.
 */
export async function forgetManagedAgent(agentId: string): Promise<void> {
  const record = await getManagedAgentRecord(agentId);
  if (!record) return;
  for (const identity of record.identities)
    await encryptedAppSecretsStore.deleteSecret(
      credentialsStashKey(agentId, identity.switchAgentId)
    );
  await deleteManagedAgentRecord(agentId);
}
