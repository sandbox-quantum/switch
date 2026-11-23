import { describe, expect, it, vi } from 'vitest';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

vi.mock('@renderer/features/switch-servers/server-availability', () => ({
  serverAvailability: () => 'unreachable',
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: { isBlocked: () => false },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({ localServerStore: {} }));
vi.mock('@renderer/features/switch-servers/remote-server-store', () => ({ remoteServerStore: {} }));

const { serverStatusLabel } = await import('@renderer/features/switch-servers/server-presentation');

function server(fields: Partial<SwitchServer>): SwitchServer {
  return {
    id: 'srv',
    name: 'Server',
    url: 'http://localhost:41001',
    managed: false,
    managementKind: null,
    sshHost: null,
    ...fields,
  } as SwitchServer;
}

describe('the label of a server that cannot be reached', () => {
  it('names the address of a server this app does not run', () => {
    expect(serverStatusLabel(server({ url: 'https://switch.example.com' }))).toBe(
      "Can't reach switch.example.com"
    );
  });

  it('keeps the usual label for a managed local server', () => {
    expect(serverStatusLabel(server({ managed: true, managementKind: 'local' }))).toBe(
      'Unreachable'
    );
  });

  it('keeps the usual label for a managed server forwarded over SSH', () => {
    expect(
      serverStatusLabel(
        server({
          managed: true,
          managementKind: 'remote',
          sshHost: 'vm-1',
          url: 'http://localhost:41007',
        })
      )
    ).toBe('Unreachable');
  });
});
