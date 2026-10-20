import { Cloud, Globe, Laptop, Server } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

vi.mock('./switch-cloud-store', () => ({
  isSwitchCloudServer: (server: SwitchServer) => server.url === 'https://cloud.example.invalid',
}));

const { serverIcon } = await import('./server-icon');

function server(patch: Partial<SwitchServer>): SwitchServer {
  return {
    id: 'srv',
    name: 'srv',
    url: 'https://srv.example.invalid',
    dashboardUrl: null,
    managed: false,
    managementKind: null,
    sshHost: null,
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

describe('the icon for a server', () => {
  it('is a cloud for Switch Cloud', () => {
    expect(serverIcon(server({ url: 'https://cloud.example.invalid' }))).toBe(Cloud);
  });

  it('is a globe for any other server reached by URL', () => {
    expect(serverIcon(server({}))).toBe(Globe);
  });

  it('is a laptop or a server for the stacks Console runs', () => {
    expect(serverIcon(server({ managed: true, managementKind: 'local' }))).toBe(Laptop);
    expect(serverIcon(server({ managed: true, managementKind: 'remote', sshHost: 'vm-1' }))).toBe(
      Server
    );
  });
});
