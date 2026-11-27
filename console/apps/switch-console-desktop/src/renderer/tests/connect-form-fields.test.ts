import { describe, expect, it } from 'vitest';
import { unreachableFromInternet } from '@renderer/features/switch-servers/connect-form-fields';

describe('whether Microsoft could reach the server', () => {
  const server = (
    url: string,
    managed = false,
    managementKind: 'local' | 'remote' | null = null
  ) => ({
    url,
    managed,
    managementKind,
  });

  it('cannot reach one Switch Console runs on this computer', () => {
    expect(unreachableFromInternet(server('https://switch.example.com', true, 'local'))).toBe(true);
  });

  it.each([
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://10.0.0.5',
    'http://172.20.1.1',
    'http://192.168.1.10:8000',
    'https://switch.local',
    'http://[::1]:8000',
    'http://[fd12::1]',
  ])('cannot reach %s', (url) => {
    expect(unreachableFromInternet(server(url))).toBe(true);
  });

  it.each(['https://switch.example.com', 'https://172.32.0.1', 'https://203.0.113.9'])(
    'can reach %s',
    (url) => {
      expect(unreachableFromInternet(server(url))).toBe(false);
    }
  );

  it('can reach one Console runs on an SSH host at a public address', () => {
    expect(unreachableFromInternet(server('https://switch.example.com', true, 'remote'))).toBe(
      false
    );
  });
});
