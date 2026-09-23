import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEnvFile } from './env-file';
import type { LocalServerSecrets } from './secret-values';

const secrets: LocalServerSecrets = {
  dbPassword: 'db-pw',
  dbRuntimePassword: 'db-runtime-pw',
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
    sessionDemo: false,
    telemetryEnabled: false,
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
    expect(vars.DB_PASSWORD).toBe('db-runtime-pw');
    expect(vars.DB_OWNER_PASSWORD).toBe('db-pw');
    expect(vars.AGENT_REGISTRATION_TOKEN).toBe('agent-token');
    expect(vars.JWT_SECRET_KEY).toBe('jwt-key');
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
      // The recorded session demo, which posts a card into a real channel with
      // no session behind it. Off is the correct state for a released Console:
      // it is written only for a stack built from a local checkout, and this
      // `env` is the released one. Temporary — goes when the demo does.
      'SESSION_DEMO_ENABLED',
      // The four below configure switch-core as a distributed messaging app —
      // one app we own, installed by a customer into their own workspace, with
      // the platform posting events to URLs declared once in the app manifest.
      // A managed stack cannot be one of those and is not meant to be: it binds
      // to loopback, so no platform can reach its callback or event URLs, and
      // the credentials are the app owner's rather than anything this machine
      // could hold. switch-core registers no installer without them and the
      // operator UI says so rather than offering a button that would fail at
      // Slack. Connecting a workspace from here is the other path — an operator
      // registering a bridge with their own app's token.
      'MESSAGING_PUBLIC_URL',
      'SLACK_APP_CLIENT_ID',
      'SLACK_APP_CLIENT_SECRET',
      'SLACK_APP_SIGNING_SECRET',
    ]);

    const missing = [...interpolated]
      .filter((key) => !intentionallyUnset.has(key))
      .filter((key) => !vars[key])
      .sort();

    expect(missing, 'compose interpolates these but the .env does not set them').toEqual([]);
  });

  it('turns the session demo on for a checkout build and off otherwise', () => {
    // The .env is regenerated on every start, so a developer has nowhere to set
    // this by hand — and a released Console runs pinned images that have never
    // heard of it. Temporary, and it goes when the demo does.
    expect(env).not.toContain('SESSION_DEMO_ENABLED');
    const fromCheckout = buildEnvFile({
      version: 'checkout',
      registry: 'ghcr.io',
      namespace: 'sandbox-quantum',
      ports: { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 },
      secrets,
      sessionDemo: true,
      telemetryEnabled: false,
    });
    expect(fromCheckout).toContain('SESSION_DEMO_ENABLED=true');
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
      sessionDemo: false,
      telemetryEnabled: true,
    });
    expect(sharing).toContain('TELEMETRY_ENABLED=true');
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
