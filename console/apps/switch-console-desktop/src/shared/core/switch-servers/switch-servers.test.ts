import { describe, expect, it } from 'vitest';
import { dashboardOrigin, runsOnThisComputer } from './switch-servers';

describe('dashboardOrigin', () => {
  it('is the server’s own address when it keeps no dashboard apart', () => {
    expect(dashboardOrigin({ url: 'https://switch.example.com', dashboardUrl: null })).toBe(
      'https://switch.example.com'
    );
  });

  it('is the separate dashboard address while the server keeps one', () => {
    expect(
      dashboardOrigin({
        url: 'https://switch-api.example.com',
        dashboardUrl: 'https://switch-gateway.example.com',
      })
    ).toBe('https://switch-gateway.example.com');
  });
});

describe('runsOnThisComputer', () => {
  it('is a server Console runs on this computer', () => {
    expect(runsOnThisComputer({ managed: true, managementKind: 'local' })).toBe(true);
  });

  it('reads a managed row from before kinds were recorded as this computer’s', () => {
    expect(runsOnThisComputer({ managed: true, managementKind: null })).toBe(true);
  });

  it('is not a server Console runs on an SSH host, which other Consoles open too', () => {
    expect(runsOnThisComputer({ managed: true, managementKind: 'remote' })).toBe(false);
  });

  it('is not a server someone else runs', () => {
    expect(runsOnThisComputer({ managed: false, managementKind: null })).toBe(false);
  });
});
