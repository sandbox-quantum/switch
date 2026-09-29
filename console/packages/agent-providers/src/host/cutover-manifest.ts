import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The layout version of a hosted worker's volume. The bootstrap's preflight
 * writes it once the volume is in this layout, the watcher refuses to attach
 * without it, and Switch refuses a worker that states an older one.
 */
export const HOSTED_STATE_VERSION = 1;
export const STATE_VERSION_FILE = 'state-version.json';
export const PREFLIGHT_BLOCKED_FILE = 'preflight-blocked.json';
const MANIFEST_FILE = join('cutover', 'manifest.json');
const UPLOADED_FILE = join('cutover', 'uploaded.json');

const hostState = z.enum(['accepted', 'dispatched', 'finished']);
export const cutoverItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room_message'),
    session_id: z.string().min(1).nullable(),
    room_id: z.string().min(1),
    message_id: z.string().min(1),
    thread_id: z.string().min(1).nullable(),
    room_pending: z.boolean(),
    failure_notified: z.boolean(),
    host: hostState.nullable(),
  }),
  z.strictObject({
    kind: z.literal('console_command'),
    session_id: z.string().min(1),
    command_id: z.string().min(1),
    host: hostState,
  }),
  z.strictObject({
    kind: z.literal('request_open'),
    session_id: z.string().min(1),
    request_id: z.string().min(1),
    room_id: z.string().min(1).nullable(),
    thread_id: z.string().min(1).nullable(),
  }),
  z.strictObject({ kind: z.literal('reset_pending'), session_id: z.string().min(1) }),
]);
export type CutoverItem = z.infer<typeof cutoverItemSchema>;
const manifestSchema = z.strictObject({
  manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(cutoverItemSchema),
});
export type CutoverManifest = z.infer<typeof manifestSchema>;
const stateVersionSchema = z.strictObject({ version: z.number().int().positive() });

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  await rename(temporary, path);
}

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path} cannot be read: ${String(error)}`);
  }
}

/** The volume's layout version, or null for a volume no preflight has finished. */
export async function readStateVersion(root: string): Promise<number | null> {
  const value = await optionalJson(join(root, STATE_VERSION_FILE));
  return value === undefined ? null : stateVersionSchema.parse(value).version;
}

export async function writeStateVersion(root: string): Promise<void> {
  await writeJsonAtomically(join(root, STATE_VERSION_FILE), { version: HOSTED_STATE_VERSION });
}

export async function readCutoverManifest(root: string): Promise<CutoverManifest | null> {
  const value = await optionalJson(join(root, MANIFEST_FILE));
  return value === undefined ? null : manifestSchema.parse(value);
}

/** Written once: a rerun of the preflight keeps the manifest, and its digest, it first wrote. */
export async function writeCutoverManifest(
  root: string,
  manifest: CutoverManifest
): Promise<CutoverManifest> {
  const saved = await readCutoverManifest(root);
  if (saved) return saved;
  await mkdir(join(root, 'cutover'), { recursive: true, mode: 0o700 });
  await writeJsonAtomically(join(root, MANIFEST_FILE), manifest);
  return manifest;
}

/** The manifest Switch has not yet confirmed, or null once it has (or there is none). */
export async function unconfirmedCutoverManifest(root: string): Promise<CutoverManifest | null> {
  const manifest = await readCutoverManifest(root);
  if (!manifest) return null;
  const uploaded = await optionalJson(join(root, UPLOADED_FILE));
  if (
    uploaded !== undefined &&
    z.strictObject({ manifest_sha256: z.string() }).parse(uploaded).manifest_sha256 ===
      manifest.manifest_sha256
  )
    return null;
  return manifest;
}

export async function confirmCutoverManifest(root: string, sha256: string): Promise<void> {
  await writeJsonAtomically(join(root, UPLOADED_FILE), { manifest_sha256: sha256 });
}
