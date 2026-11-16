import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { replaceFile } from './replace-file';

/**
 * What the person using this device allows the agents a Switch server assigns
 * to an agent controller here, whatever the agents' definitions ask for. Kept
 * in the controller's data directory and never sent to the server, so a
 * server (or anyone who can edit an agent's definition on it) cannot grant
 * itself more than the device's own user did.
 *
 * - `bypass`: the agent may run without asking for approval (its definition's
 *   `auto_approve`). Without it the agent runs, and asks.
 * - `directories`: folders outside the controller's workspaces folder the
 *   agent may work in, each with everything inside it.
 *
 * `*` stands for every agent. Switch Console writes this file for the
 * controller it runs; `switch-agent-controller allow` and `disallow` write it
 * for a headless one.
 */
export const DEVICE_POLICY_FILE = 'device-policy.json';

/** The agent id in a device policy that stands for every agent. */
export const EVERY_AGENT = '*';

const grantSchema = z.strictObject({
  bypass: z.literal(true).optional(),
  directories: z.array(z.string().min(1)).optional(),
});

export const devicePolicySchema = z.strictObject({
  version: z.literal(1),
  agents: z.record(z.string().min(1), grantSchema),
});

export type DevicePolicy = z.infer<typeof devicePolicySchema>;

/** What a device allows one agent: one of the two, or both. */
export type DeviceGrant = { bypass: boolean; directory: string | null };

export function emptyDevicePolicy(): DevicePolicy {
  return { version: 1, agents: {} };
}

/** The policy in `dataDir`; none allows nothing. A file that cannot be read as one is an error. */
export async function readDevicePolicy(dataDir: string): Promise<DevicePolicy> {
  const path = join(dataDir, DEVICE_POLICY_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDevicePolicy();
    throw error;
  }
  const parsed = devicePolicySchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      `${path} is not a device policy this version can read: ${parsed.error.message}`
    );
  return parsed.data;
}

/** Replaces the policy in `dataDir`, readable by this user only. */
export async function writeDevicePolicy(dataDir: string, policy: DevicePolicy): Promise<void> {
  const path = join(dataDir, DEVICE_POLICY_FILE);
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(devicePolicySchema.parse(policy), null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await replaceFile(temporary, path);
}

function fold(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

/** `path` is `root` or inside it, ignoring case where the file system does. */
export function withinDirectory(root: string, path: string): boolean {
  const rest = relative(fold(root), fold(path));
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function grantsOf(policy: DevicePolicy, agentId: string) {
  return [policy.agents[agentId], policy.agents[EVERY_AGENT]].filter((grant) => !!grant);
}

export function policyAllowsBypass(policy: DevicePolicy, agentId: string): boolean {
  return grantsOf(policy, agentId).some((grant) => grant.bypass === true);
}

/** Whether `directory` (absolute) is one the device allows the agent, or inside one. */
export function policyAllowsDirectory(
  policy: DevicePolicy,
  agentId: string,
  directory: string
): boolean {
  return grantsOf(policy, agentId).some((grant) =>
    (grant.directories ?? []).some((allowed) => withinDirectory(allowed, directory))
  );
}

/** `policy` with `grant` added for the agent. A directory must be absolute. */
export function allowInPolicy(
  policy: DevicePolicy,
  agentId: string,
  grant: DeviceGrant
): DevicePolicy {
  if (grant.directory !== null && !isAbsolute(grant.directory))
    throw new Error(`The directory '${grant.directory}' is not an absolute path.`);
  const next = structuredClone(policy);
  const current = next.agents[agentId] ?? {};
  if (grant.bypass) current.bypass = true;
  if (grant.directory !== null) {
    const directory = resolve(grant.directory);
    const directories = current.directories ?? [];
    if (!directories.includes(directory)) current.directories = [...directories, directory];
  }
  next.agents[agentId] = current;
  return next;
}

/** `policy` without `grant` for the agent; `'all'` takes away everything it allowed the agent. */
export function disallowInPolicy(
  policy: DevicePolicy,
  agentId: string,
  grant: DeviceGrant | 'all'
): DevicePolicy {
  const next = structuredClone(policy);
  const current = next.agents[agentId];
  if (!current) return next;
  if (grant === 'all') {
    delete next.agents[agentId];
    return next;
  }
  if (grant.bypass) delete current.bypass;
  if (grant.directory !== null) {
    const directory = resolve(grant.directory);
    const directories = (current.directories ?? []).filter((allowed) => allowed !== directory);
    if (directories.length) current.directories = directories;
    else delete current.directories;
  }
  if (current.bypass === undefined && current.directories === undefined)
    delete next.agents[agentId];
  return next;
}

/**
 * What an agent assigned to a controller here asks for that this device has
 * not allowed: running without approvals, a directory outside the
 * controller's workspaces folder, or both.
 */
export type DeviceConsentNeed = {
  agentId: string;
  name: string;
  displayName: string | null;
  bypass: boolean;
  directory: string | null;
};

/**
 * The controller telling Switch Console, which runs it, every assigned agent
 * that asks for something this device has not allowed. Sent whenever that list
 * changes; an empty list means nothing is waiting.
 */
export const DEVICE_CONSENT_NEEDED_KIND = 'switch-device-consent-needed';

/** Console telling the controller it runs that it changed the device policy. */
export const DEVICE_POLICY_CHANGED_KIND = 'switch-device-policy-changed';

export type DeviceConsentNeededMessage = {
  kind: typeof DEVICE_CONSENT_NEEDED_KIND;
  needs: DeviceConsentNeed[];
};

export type DevicePolicyChangedMessage = { kind: typeof DEVICE_POLICY_CHANGED_KIND };

const consentNeededSchema = z.object({
  kind: z.literal(DEVICE_CONSENT_NEEDED_KIND),
  needs: z.array(
    z.object({
      agentId: z.string().min(1),
      name: z.string(),
      displayName: z.string().nullable(),
      bypass: z.boolean(),
      directory: z.string().nullable(),
    })
  ),
});

export function isDeviceConsentNeededMessage(raw: unknown): raw is DeviceConsentNeededMessage {
  return consentNeededSchema.safeParse(raw).success;
}

export function isDevicePolicyChangedMessage(raw: unknown): raw is DevicePolicyChangedMessage {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === DEVICE_POLICY_CHANGED_KIND
  );
}
