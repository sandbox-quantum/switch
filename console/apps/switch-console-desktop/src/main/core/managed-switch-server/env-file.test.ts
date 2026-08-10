import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEnvFile } from './env-file';
import type { LocalServerSecrets } from './secret-values';

const secrets: LocalServerSecrets = {
  dbPassword: 'db-pw',
  matrixRegistrationSharedSecret: 'matrix-shared',
  matrixAdminPassword: 'matrix-admin',
  agentRegistrationToken: 'agent-token',
  jwtSecretKey: 'jwt-key',
  gatewayAdminPassword: 'gw-admin',
  mattermostAdminPassword: 'mm-admin',
  mattermostUserPassword: 'mm-user',
};

/** The compose file Switch Console writes beside the `.env`, and whose `${VAR}`
 *  interpolations the `.env` has to satisfy. */
const composeYaml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'resources/standalone-docker-compose.pinned.yml'),
  'utf8'
);

describe('buildEnvFile', () => {
  const env = buildEnvFile({
    version: '1.2.3',
    registry: 'ghcr.io',
    namespace: 'sandbox-quantum',
    ports: { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 },
    secrets,
  });
  const vars = Object.fromEntries(
    env
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=') as [string, string])
      .filter(([k]) => k)
  );

  it('pins the image coordinates from params', () => {
    expect(vars.SWITCH_REGISTRY).toBe('ghcr.io');
    expect(vars.SWITCH_IMAGE_NAMESPACE).toBe('sandbox-quantum');
    expect(vars.SWITCH_VERSION).toBe('1.2.3');
  });

  it('publishes every host port from the chosen (free) port set', () => {
    expect(vars.GATEWAY_HOST_PORT).toBe('51000');
    expect(vars.API_HOST_PORT).toBe('51001');
    expect(vars.MATTERMOST_HOST_PORT).toBe('51002');
    expect(vars.POSTGRES_HOST_PORT).toBe('51003');
    expect(vars.FRONTEND_BASE_URL).toBe('http://localhost:51000');
  });

  it('binds the managed stack to loopback and seeds the admin account', () => {
    expect(vars.SWITCH_BIND_ADDR).toBe('127.0.0.1');
    expect(vars.GATEWAY_ADMIN_EMAIL).toBe('admin@switch.local');
  });

  it('injects every secret into its env var', () => {
    expect(vars.DB_PASSWORD).toBe('db-pw');
    expect(vars.MATRIX_REGISTRATION_SHARED_SECRET).toBe('matrix-shared');
    expect(vars.MATRIX_ADMIN_PASSWORD).toBe('matrix-admin');
    expect(vars.AGENT_REGISTRATION_TOKEN).toBe('agent-token');
    expect(vars.JWT_SECRET_KEY).toBe('jwt-key');
    expect(vars.GATEWAY_ADMIN_PASSWORD).toBe('gw-admin');
    expect(vars.MATTERMOST_ADMIN_PASSWORD).toBe('mm-admin');
    expect(vars.MATTERMOST_USER_PASSWORD).toBe('mm-user');
  });

  it('defines every var the bundled compose file interpolates', () => {
    // Derived from the compose file rather than a hand-kept list. The previous
    // list had drifted both ways — it omitted GATEWAY_PUBLIC_URL (so the
    // "Open in Switch Console" redirect was silently disabled on every managed
    // stack) while asserting vars compose never interpolates. A list cannot
    // notice a variable being added to the contract; this can.
    const interpolated = new Set(
      [...composeYaml.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1])
    );
    // Nothing is exempt today. An entry here must say why the stack is correct
    // without it — leaving a var unset is a decision, not a default.
    const intentionallyUnset = new Set<string>();

    const missing = [...interpolated]
      .filter((key) => !intentionallyUnset.has(key))
      .filter((key) => !vars[key])
      .sort();

    expect(missing, 'compose interpolates these but the .env does not set them').toEqual([]);
  });

  it('points the deeplink redirect at the API, not the operator UI', () => {
    // switch-core only rewrites `switchdash://` links into clickable http ones
    // when this is set, and serves the redirect on the agent-bridge app — so
    // the gateway's own URL here would produce links that 404.
    expect(vars.GATEWAY_PUBLIC_URL).toBe('http://localhost:51001');
    expect(vars.FRONTEND_BASE_URL).toBe('http://localhost:51000');
  });
});
