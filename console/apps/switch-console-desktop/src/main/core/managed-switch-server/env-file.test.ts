import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEnvFile, keysDisagreeing, readStackEnv, telemetryRequested } from './env-file';
import type { LocalServerSecrets } from './secret-values';

const secrets: LocalServerSecrets = {
  dbPassword: 'db-pw',
  dbRuntimePassword: 'db-runtime-pw',
  agentRegistrationToken: 'agent-token',
  jwtSecretKey: 'jwt-key',
  secretKeys: 'console:secret-keys-value',
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
    telemetryEnabled: false,
    telemetryEnvironment: 'prod',
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
    expect(vars.GATEWAY_COOKIE_SECURE).toBe('false');
    expect(vars.GATEWAY_ADMIN_EMAIL).toBe('admin@switch.local');
  });

  it('injects every secret into its env var', () => {
    expect(vars.DB_PASSWORD).toBe('db-runtime-pw');
    expect(vars.DB_OWNER_PASSWORD).toBe('db-pw');
    expect(vars.AGENT_REGISTRATION_TOKEN).toBe('agent-token');
    expect(vars.JWT_SECRET_KEY).toBe('jwt-key');
    expect(vars.SECRET_KEYS).toBe('console:secret-keys-value');
    expect(vars.GATEWAY_ADMIN_PASSWORD).toBe('gw-admin');
    expect(vars.MATTERMOST_ADMIN_PASSWORD).toBe('mm-admin');
    expect(vars.MATTERMOST_USER_PASSWORD).toBe('mm-user');
  });

  it('runs switch-core as the restricted runtime role, not the schema owner', () => {
    // The runtime role name is fixed (switch_app), not derived from the
    // secrets bundle: init-db creates exactly this role, so drifting the name
    // here would create a role nothing grants access to.
    expect(vars.DB_USER).toBe('switch_app');
    expect(vars.DB_OWNER_USER).toBe('postgres');
  });

  it('defines every var the bundled compose file interpolates', () => {
    // Derived from the compose file rather than a hand-kept list. The previous
    // list had drifted both ways — it omitted GATEWAY_PUBLIC_URL (so the
    // "Open in Switch Console" redirect was silently disabled on every managed
    // stack) while asserting vars compose never interpolates. A list cannot
    // notice a variable being added to the contract; this can.
    // Comments are stripped first: they document the interpolation syntax, and
    // an example in prose is not a variable the stack needs set.
    const composeBody = composeYaml
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const interpolated = new Set(
      [...composeBody.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1])
    );
    // An entry here must say why the stack is correct without it — leaving a
    // var unset is a decision, not a default.
    const intentionallyUnset = new Set<string>([
      // The vars below configure switch-core as a distributed messaging app —
      // one app we own, installed by a customer into their own workspace. A
      // managed stack cannot be one of those and is not meant to be: it binds
      // to loopback, so no platform can reach the OAuth redirect the install
      // needs (and switch-core makes MESSAGING_PUBLIC_URL a startup requirement
      // the moment a distributed app is configured, so setting the credentials
      // without it would fail boot), and the credentials are the app owner's
      // rather than anything this machine could hold. switch-core registers no
      // installer without them and the operator UI says so rather than offering
      // a button that would fail at the platform. Connecting a workspace from
      // here is the other path — an operator registering a bridge with their
      // own app's token.
      'MESSAGING_PUBLIC_URL',
      'SLACK_APP_CLIENT_ID',
      'SLACK_APP_CLIENT_SECRET',
      'SLACK_APP_SIGNING_SECRET',
      // Discord grants no per-install token, so its four are deployment config
      // rather than per-workspace secrets. None can be held by a loopback stack
      // (see above), so all are unset here.
      'DISCORD_APP_CLIENT_ID',
      'DISCORD_APP_CLIENT_SECRET',
      'DISCORD_APP_BOT_TOKEN',
      'DISCORD_APP_APPLICATION_ID',
      // Private hosts Switch may reach at a tenant- or agent-supplied URL. The
      // compose file always allows the bundled Mattermost; a managed stack
      // allows nothing more until its operator says so.
      'OUTBOUND_ALLOWED_PRIVATE_HOSTS',
    ]);

    const missing = [...interpolated]
      .filter((key) => !intentionallyUnset.has(key))
      .filter((key) => !vars[key])
      .sort();

    expect(missing, 'compose interpolates these but the .env does not set them').toEqual([]);
  });

  it('never passes the removed session demo switch, which older switch-core images reject when empty', () => {
    expect(env).not.toContain('SESSION_DEMO_ENABLED');
  });

  it('carries the telemetry answer in both directions, never by omission', () => {
    // The compose file passes this key through only when the `.env` names it,
    // so leaving it out on "no" would let a stack started under a "yes" keep
    // reporting. Off has to be written down (CHOO-2890).
    expect(vars.TELEMETRY_ENABLED).toBe('false');

    const sharing = buildEnvFile({
      version: '1.2.3',
      registry: 'ghcr.io',
      namespace: 'sandbox-quantum',
      ports: { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 },
      secrets,
      telemetryEnabled: true,
      telemetryEnvironment: 'prod',
    });
    expect(sharing).toContain('TELEMETRY_ENABLED=true');
  });

  it('tells the server which Amplitude project its usage belongs in', () => {
    // The relay files each event under the project its environment names, so a
    // server a development build runs must say so as plainly as the app does.
    const fromDevBuild = buildEnvFile({
      version: '1.2.3',
      registry: 'ghcr.io',
      namespace: 'sandbox-quantum',
      ports: { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 },
      secrets,
      telemetryEnabled: true,
      telemetryEnvironment: 'local',
    });

    expect(fromDevBuild).toContain('TELEMETRY_ENVIRONMENT=local');
    expect(vars.TELEMETRY_ENVIRONMENT).toBe('prod');
    // Written but never forwarded would reach no container.
    expect(composeYaml).toMatch(/^\s+TELEMETRY_ENVIRONMENT:\s*$/m);
  });

  it('is the only thing the compose file needs to forward the gate', () => {
    // A value in the `.env` that the `switch` service does not name never
    // reaches the container, which is the failure mode this pairing exists to
    // rule out — the writer and the contract have to agree.
    expect(composeYaml).toMatch(/^\s+TELEMETRY_ENABLED:\s*$/m);
  });

  it('points the deeplink redirect at the API, not the operator UI', () => {
    // switch-core only rewrites `switchdash://` links into clickable http ones
    // when this is set, and serves the redirect on the agent-bridge app — so
    // the gateway's own URL here would produce links that 404.
    expect(vars.GATEWAY_PUBLIC_URL).toBe('http://localhost:51001');
    expect(vars.FRONTEND_BASE_URL).toBe('http://localhost:51000');
  });
});

describe('readStackEnv', () => {
  const ports = { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 };
  const written = buildEnvFile({
    version: '1.2.3',
    registry: 'ghcr.io',
    namespace: 'sandbox-quantum',
    ports,
    secrets,
    telemetryEnabled: true,
    telemetryEnvironment: 'prod',
  });

  it('reads back exactly what buildEnvFile wrote', () => {
    expect(readStackEnv(written)).toEqual({
      kind: 'complete',
      env: { ports, secrets, version: '1.2.3' },
    });
  });

  it('reads a file written before the database role split', () => {
    const legacy = written
      .replace('DB_USER=switch_app', 'DB_USER=postgres')
      .replace(`DB_PASSWORD=${secrets.dbRuntimePassword}`, `DB_PASSWORD=${secrets.dbPassword}`)
      .replace(/^DB_OWNER_USER=.*$/m, '')
      .replace(/^DB_OWNER_PASSWORD=.*$/m, '');

    expect(readStackEnv(legacy)).toEqual({
      kind: 'complete',
      env: {
        ports,
        secrets: { ...secrets, dbRuntimePassword: null },
        version: '1.2.3',
      },
    });
  });

  it('reads a file written before SECRET_KEYS, leaving the key ring to be filled in', () => {
    const legacy = written.replace(/^SECRET_KEYS=.*$/m, '');

    expect(readStackEnv(legacy)).toEqual({
      kind: 'complete',
      env: { ports, secrets: { ...secrets, secretKeys: null }, version: '1.2.3' },
    });
  });

  it('names the owner password a file from before the role split is missing', () => {
    const legacy = written
      .replace('DB_USER=switch_app', 'DB_USER=postgres')
      .replace(/^DB_PASSWORD=.*$/m, '')
      .replace(/^DB_OWNER_USER=.*$/m, '')
      .replace(/^DB_OWNER_PASSWORD=.*$/m, '');

    expect(readStackEnv(legacy)).toMatchObject({
      kind: 'incomplete',
      missing: expect.arrayContaining(['DB_PASSWORD']),
    });
  });

  it('reads whether a stack asks to share usage data', () => {
    expect(telemetryRequested('TELEMETRY_ENABLED=true\n')).toBe(true);
    expect(telemetryRequested('TELEMETRY_ENABLED=false\n')).toBe(false);
    // Absent is off: switch-core's own default for the gate.
    expect(telemetryRequested('GATEWAY_HOST_PORT=3300\n')).toBe(false);
  });

  it('names every key it could not find instead of inventing a value', () => {
    const partial = written
      .replace(/^JWT_SECRET_KEY=.*$/m, '')
      .replace(/^API_HOST_PORT=.*$/m, 'API_HOST_PORT=')
      .replace(/^MATTERMOST_USER_PASSWORD=.*$/m, '');

    expect(readStackEnv(partial)).toEqual({
      kind: 'incomplete',
      missing: ['API_HOST_PORT', 'JWT_SECRET_KEY', 'MATTERMOST_USER_PASSWORD'],
    });
  });

  it('does not read a port that is not one', () => {
    const garbled = written
      .replace('GATEWAY_HOST_PORT=51000', 'GATEWAY_HOST_PORT=http://localhost:51000')
      .replace('POSTGRES_HOST_PORT=51003', 'POSTGRES_HOST_PORT=70000');

    expect(readStackEnv(garbled)).toEqual({
      kind: 'incomplete',
      missing: ['GATEWAY_HOST_PORT', 'POSTGRES_HOST_PORT'],
    });
  });

  it('refuses a current-layout file whose runtime password is gone', () => {
    const noRuntime = written.replace(/^DB_PASSWORD=.*$/m, '');

    expect(readStackEnv(noRuntime)).toEqual({ kind: 'incomplete', missing: ['DB_PASSWORD'] });
  });

  it('refuses a file that names no schema owner at all', () => {
    const noOwner = written
      .replace(/^DB_OWNER_PASSWORD=.*$/m, '')
      .replace(/^DB_OWNER_USER=.*$/m, '');

    expect(readStackEnv(noOwner)).toEqual({
      kind: 'incomplete',
      missing: ['DB_OWNER_PASSWORD'],
    });
  });

  it('treats an empty file as missing everything', () => {
    const reading = readStackEnv('');

    expect(reading.kind).toBe('incomplete');
    expect(reading.kind === 'incomplete' && reading.missing).toHaveLength(10);
  });
});

describe('keysDisagreeing', () => {
  const ports = { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 };
  const written = buildEnvFile({
    version: '1.2.3',
    registry: 'ghcr.io',
    namespace: 'sandbox-quantum',
    ports,
    secrets,
    telemetryEnabled: true,
    telemetryEnvironment: 'prod',
  });

  it('finds nothing wrong with a copy of the same settings', () => {
    expect(keysDisagreeing(written, { ports, secrets })).toEqual([]);
  });

  it('names the ports and credentials a copy of another generation gets wrong', () => {
    const copy = {
      ports: { ...ports, gateway: 3300 },
      secrets: { ...secrets, dbPassword: 'old-owner-pw', gatewayAdminPassword: 'old-admin' },
    };

    expect(keysDisagreeing(written, copy).sort()).toEqual([
      'DB_OWNER_PASSWORD',
      'GATEWAY_ADMIN_PASSWORD',
      'GATEWAY_HOST_PORT',
    ]);
  });

  it('judges only what the file carries, and not what a start rewrites', () => {
    const partial = written
      .replace(/^JWT_SECRET_KEY=.*$/m, '')
      .replace('SWITCH_VERSION=1.2.3', 'SWITCH_VERSION=0.0.1');

    expect(keysDisagreeing(partial, { ports, secrets: { ...secrets, jwtSecretKey: 'x' } })).toEqual(
      []
    );
  });

  it('names a key ring the copy disagrees with', () => {
    expect(
      keysDisagreeing(written, { ports, secrets: { ...secrets, secretKeys: 'console:other' } })
    ).toEqual(['SECRET_KEYS']);
  });

  it('reads DB_PASSWORD as the owner’s in a file written before the role split', () => {
    const legacy = written
      .replace('DB_USER=switch_app', 'DB_USER=postgres')
      .replace(`DB_PASSWORD=${secrets.dbRuntimePassword}`, `DB_PASSWORD=${secrets.dbPassword}`)
      .replace(/^DB_OWNER_USER=.*$/m, '')
      .replace(/^DB_OWNER_PASSWORD=.*$/m, '');

    expect(keysDisagreeing(legacy, { ports, secrets })).toEqual([]);
    expect(
      keysDisagreeing(legacy, { ports, secrets: { ...secrets, dbPassword: 'other' } })
    ).toEqual(['DB_PASSWORD']);
  });

  it('reads DB_PASSWORD as the runtime role’s when the owner’s line is what is missing', () => {
    const partial = written.replace(/^DB_OWNER_PASSWORD=.*$/m, '');

    expect(keysDisagreeing(partial, { ports, secrets })).toEqual([]);
    expect(
      keysDisagreeing(partial, { ports, secrets: { ...secrets, dbRuntimePassword: 'other' } })
    ).toEqual(['DB_PASSWORD']);
  });
});
