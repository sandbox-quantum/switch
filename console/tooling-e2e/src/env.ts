import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuration for the harness. Every value is a secret or a deployment
 * address, so nothing is hard-coded: it comes from the process environment, or
 * from a gitignored `.env` beside this package.
 */
export interface HarnessEnv {
  switchApiUrl: string;
  gatewayAdminEmail: string;
  gatewayAdminPassword: string;
  agentRegistrationToken: string;
  mattermostUrl: string;
  mattermostToken: string;
  mattermostTeam: string;
  /** Working directory the console session under test runs OpenCode from. */
  agentRepoDir: string | null;
  /** Leave the channel and agent behind after the run (for debugging). */
  keepArtifacts: boolean;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse `KEY=VALUE` lines. Blank lines and `#` comments are skipped; a value may
 * be wrapped in single or double quotes. Deliberately tiny — this is the only
 * reason the package would otherwise need a dotenv dependency.
 */
export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Values from `.env` beside this package, or `{}` when there is no such file. */
export function readDotEnvFile(file = path.join(PACKAGE_ROOT, '.env')): Record<string, string> {
  try {
    return parseDotEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export class MissingConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required configuration: ${missing.join(', ')}. ` +
        `Set them in the environment or in console/tooling-e2e/.env (see README.md).`
    );
    this.name = 'MissingConfigError';
    this.missing = missing;
  }
}

/**
 * Resolve the harness configuration from `process.env` layered over `.env`.
 * Throws {@link MissingConfigError} naming every absent variable at once rather
 * than failing on the first — a first run is usually missing several.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): HarnessEnv {
  const file = readDotEnvFile();
  const get = (key: string): string | undefined => {
    const value = source[key] ?? file[key];
    return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
  };

  const required = {
    SWITCH_API_URL: get('SWITCH_API_URL'),
    SWITCH_GATEWAY_ADMIN_EMAIL: get('SWITCH_GATEWAY_ADMIN_EMAIL'),
    SWITCH_GATEWAY_ADMIN_PASSWORD: get('SWITCH_GATEWAY_ADMIN_PASSWORD'),
    SWITCH_AGENT_REGISTRATION_TOKEN: get('SWITCH_AGENT_REGISTRATION_TOKEN'),
    MATTERMOST_URL: get('MATTERMOST_URL'),
    MATTERMOST_TOKEN: get('MATTERMOST_TOKEN'),
    MATTERMOST_TEAM: get('MATTERMOST_TEAM'),
  };

  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) throw new MissingConfigError(missing);

  return {
    switchApiUrl: stripTrailingSlash(required.SWITCH_API_URL as string),
    gatewayAdminEmail: required.SWITCH_GATEWAY_ADMIN_EMAIL as string,
    gatewayAdminPassword: required.SWITCH_GATEWAY_ADMIN_PASSWORD as string,
    agentRegistrationToken: required.SWITCH_AGENT_REGISTRATION_TOKEN as string,
    mattermostUrl: stripTrailingSlash(required.MATTERMOST_URL as string),
    mattermostToken: required.MATTERMOST_TOKEN as string,
    mattermostTeam: required.MATTERMOST_TEAM as string,
    agentRepoDir: get('SWITCH_E2E_AGENT_DIR') ?? null,
    keepArtifacts: (get('SWITCH_E2E_KEEP') ?? '') === '1',
  };
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Lowercase, filesystem- and Mattermost-username-safe run id. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * A message that names the running config without disclosing any of it. Used in
 * skip reasons and the result table, which are printed to a terminal and may be
 * pasted into a ticket.
 */
export function describeEnv(env: HarnessEnv): string {
  return `switch=${env.switchApiUrl} mattermost=${env.mattermostUrl} team=${env.mattermostTeam}`;
}
