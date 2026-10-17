import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ServiceGrant } from './service-access';
import { servicesChangedNotice } from './service-notices';
import { type SessionServices, type SharedHostConfig, sessionServiceGrants } from './shared-config';

/**
 * How often a watcher with live sessions reads its agent's grants again, so a
 * service granted or taken away while they run reaches them.
 */
export const GRANTS_CHECK_MS = 30_000;

const FILE = 'services.json';
const recordSchema = z.strictObject({ shape: z.string().nullable() });

/**
 * What of an agent's grants a session builds its tools from as it starts: each
 * granted service, its skill, its vendor MCP servers and command-line tools,
 * and which of their tools it may call. A change here needs a new session
 * host. The access level, resources and revision are not part of it: tokens
 * carry those, and a running session's tokens follow them within half a
 * minute (`AgentServiceTokens`). Null when the grants could not be read.
 */
export function servicesShape(services: SessionServices): string | null {
  if (services.unavailable !== null) return null;
  return JSON.stringify(
    [...services.grants]
      .sort((a, b) => a.service.localeCompare(b.service))
      .map((grant: ServiceGrant) => ({
        service: grant.service,
        tool_mode: grant.tool_mode,
        tools: [...grant.tools].sort(),
        skill: grant.skill,
        mcp_servers: grant.mcp_servers,
        cli_tools: grant.cli_tools,
      }))
  );
}

/** Records, at a session's root, the shape of the grants its host started with. */
export async function recordSessionServices(
  sessionRoot: string,
  services: SessionServices
): Promise<void> {
  const path = join(sessionRoot, FILE);
  const temporary = `${path}.next`;
  await writeFile(temporary, JSON.stringify({ shape: servicesShape(services) }), {
    mode: 0o600,
  });
  await rename(temporary, path);
}

/**
 * The shape a session's host recorded as it started: null when it started
 * without its grants, undefined when it recorded none (a host from before
 * the record).
 */
export async function recordedServicesShape(
  sessionRoot: string
): Promise<string | null | undefined> {
  let text: string;
  try {
    text = await readFile(join(sessionRoot, FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return recordSchema.parse(JSON.parse(text)).shape;
}

/**
 * Whether a session started under other grants than `current`'s. Unknown on
 * either side (a host that recorded nothing, grants that cannot be read now)
 * is not a change: restarting on it would cost a conversation its tools for
 * nothing.
 */
export function servicesChanged(
  recorded: string | null | undefined,
  current: string | null
): boolean {
  return recorded !== undefined && current !== null && recorded !== current;
}

const shapeServicesSchema = z.array(z.object({ service: z.string() }));

/**
 * What a session is told about services that went or came since its host
 * last started: null for a host with no record (a new session, or one from
 * before the record), for grants that could not be read on either side, or
 * when the same services are granted (their tools changed, say).
 */
export function servicesChangeSince(
  recorded: string | null | undefined,
  services: SessionServices
): string | null {
  const current = servicesShape(services);
  if (recorded === undefined || recorded === null || !servicesChanged(recorded, current))
    return null;
  const parsed = shapeServicesSchema.safeParse(JSON.parse(recorded));
  if (!parsed.success) return null;
  const before = new Set(parsed.data.map((grant) => grant.service));
  const after = new Set(services.grants.map((grant) => grant.service));
  return servicesChangedNotice(
    [...before].filter((service) => !after.has(service)).sort(),
    [...after].filter((service) => !before.has(service)).sort()
  );
}

/** The shape of the agent's grants as they stand now, read as the watcher's template reaches Switch. */
export async function currentServicesShape(template: SharedHostConfig): Promise<string | null> {
  return servicesShape(await sessionServiceGrants(template));
}
