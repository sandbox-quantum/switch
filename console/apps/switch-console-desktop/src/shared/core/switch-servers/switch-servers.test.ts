import { describe, expect, it } from 'vitest';
import { dashboardOrigin } from './switch-servers';

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
