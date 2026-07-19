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

describe('buildEnvFile', () => {
  const env = buildEnvFile({
    version: '1.2.3',
    registry: 'ghcr.io',
    namespace: 'sandbox-quantum',
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

  it('defines every var the compose contract interpolates', () => {
    const required = [
      'DB_HOST',
      'DB_PORT',
      'DB_USER',
      'DB_PASSWORD',
      'DB_NAME',
      'MATRIX_SERVER',
      'MATRIX_SERVER_NAME',
      'MATRIX_ADMIN_USER',
      'MATRIX_ADMIN_PASSWORD',
      'MATRIX_REGISTRATION_SHARED_SECRET',
      'AGENT_REGISTRATION_TOKEN',
      'JWT_SECRET_KEY',
      'GATEWAY_ADMIN_EMAIL',
      'GATEWAY_ADMIN_PASSWORD',
      'FRONTEND_BASE_URL',
      'MATTERMOST_ADMIN_USER',
      'MATTERMOST_ADMIN_PASSWORD',
      'MATTERMOST_TEAM_NAME',
      'MATTERMOST_USER',
      'MATTERMOST_USER_PASSWORD',
    ];
    for (const key of required) {
      expect(vars[key], `missing ${key}`).toBeDefined();
      expect(vars[key], `empty ${key}`).not.toBe('');
    }
  });
});
