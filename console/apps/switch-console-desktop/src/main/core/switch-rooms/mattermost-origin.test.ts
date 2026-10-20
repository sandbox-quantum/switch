import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServer = vi.hoisted(() => vi.fn());
const readPersistedPorts = vi.hoisted(() => vi.fn());

vi.mock('@main/core/switch-servers/servers-store', () => ({ getServer }));
vi.mock('@main/core/managed-switch-server/ports', () => ({ readPersistedPorts }));
vi.mock('@main/core/managed-switch-server/host/host-for-server', () => ({
  managedServerStateDir: () => '/state',
}));

const { mattermostOriginFor } = await import('./mattermost-origin');

describe('mattermostOriginFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readPersistedPorts.mockResolvedValue({ gateway: 3300, api: 8000, mattermost: 8065 });
  });

  it('pairs a managed server’s host with the Mattermost port its stack publishes', async () => {
    getServer.mockResolvedValue({
      managed: true,
      url: 'http://localhost:8000',
      dashboardUrl: 'http://localhost:3300',
    });

    expect(await mattermostOriginFor('srv')).toBe('http://localhost:8065');
  });

  it('knows no Mattermost for a server it does not run', async () => {
    getServer.mockResolvedValue({ managed: false, url: 'https://switch.example.com' });

    expect(await mattermostOriginFor('srv')).toBeNull();
    expect(readPersistedPorts).not.toHaveBeenCalled();
  });

  it('knows none for a managed server whose ports were never recorded', async () => {
    getServer.mockResolvedValue({ managed: true, url: 'http://localhost:8000' });
    readPersistedPorts.mockResolvedValue(null);

    expect(await mattermostOriginFor('srv')).toBeNull();
  });
});
