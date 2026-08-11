import { describe, expect, it } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { managedServerSecretsKey } from './host-for-server';

function server(overrides: Partial<SwitchServer>): SwitchServer {
  return {
    id: 'id',
    name: 'name',
    gatewayUrl: 'http://localhost:1',
    apiUrl: 'http://localhost:2',
    managed: true,
    managementKind: 'local',
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('managedServerSecretsKey', () => {
  it('uses the single local key for a local-managed server', () => {
    expect(managedServerSecretsKey(server({ managementKind: 'local' }))).toBe(
      'local-switch-server:secrets'
    );
  });

  it('treats a legacy managed server (null kind) as local', () => {
    expect(managedServerSecretsKey(server({ managementKind: null }))).toBe(
      'local-switch-server:secrets'
    );
  });

  it('uses a per-host key for a remote-managed server', () => {
    expect(managedServerSecretsKey(server({ managementKind: 'remote', sshHost: 'prod-box' }))).toBe(
      'remote-switch-server:prod-box:secrets'
    );
  });

  it('falls back to the local key if a remote row is missing its host', () => {
    expect(managedServerSecretsKey(server({ managementKind: 'remote', sshHost: null }))).toBe(
      'local-switch-server:secrets'
    );
  });
});
