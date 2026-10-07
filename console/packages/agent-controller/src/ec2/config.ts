import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { normalizeServerUrl } from '../api';
import { ConfigurationError } from '../errors';

const absolutePath = z.string().refine(isAbsolute, 'must be an absolute path');
const hostId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/**
 * `/run/switch-machine/controller.json`, which the machine's boot unit writes
 * from its bundle. Fields this controller does not use are ignored.
 */
export const ec2ConfigSchema = z.object({
  controllerId: z.string().min(1).max(200),
  server: z.string().min(1),
  relayPort: z.number().int().min(1).max(65535),
  instanceId: hostId,
  bootId: hostId,
  kms: z.object({
    keyArn: z.string().min(1),
    region: z.string().min(1),
    grantTokens: z.array(z.string().min(1)),
    context: z.strictObject({
      'switch:tenant': z.string().min(1),
      'switch:owner_id': z.string().min(1),
      'switch:controller_id': z.string().min(1),
    }),
    /** A KMS endpoint other than the region's; for tests against a local KMS only. */
    endpoint: z.url().optional(),
  }),
  /** Claude always; another provider only when the image installed its CLI. */
  providers: z.strictObject({
    claude: absolutePath,
    codex: absolutePath.optional(),
    opencode: absolutePath.optional(),
    cursor: absolutePath.optional(),
    antigravity: absolutePath.optional(),
  }),
});
export type Ec2Config = z.infer<typeof ec2ConfigSchema>;

export async function readEc2Config(path: string): Promise<Ec2Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigurationError(
      `Could not read the machine configuration ${path}: ${(error as Error).message}`
    );
  }
  const parsed = ec2ConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigurationError(
      `The machine configuration ${path} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('; ')}`
    );
  const config = parsed.data;
  if (config.kms.context['switch:controller_id'] !== config.controllerId)
    throw new ConfigurationError(
      `The machine configuration ${path} seals logins for another controller than ${config.controllerId}.`
    );
  return { ...config, server: normalizeServerUrl(config.server) };
}

/**
 * The controller credential systemd hands the controller. Its value is never
 * part of an error: only that it is missing or malformed.
 */
export async function readCredentialFile(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError(
      `Could not read the controller credential file ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`
    );
  }
  const credential = text.trim();
  if (!credential.startsWith('swcc_') || /\s/.test(credential))
    throw new ConfigurationError(
      `The controller credential file ${path} does not hold a controller credential.`
    );
  return credential;
}

/** The id of a group named in a group file such as `/etc/group`. */
export async function groupId(name: string, groupFile: string): Promise<number> {
  const text = await readFile(groupFile, 'utf8');
  for (const line of text.split('\n')) {
    const [group, , gid] = line.split(':');
    if (group === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new ConfigurationError(`There is no group '${name}' in ${groupFile}.`);
}
