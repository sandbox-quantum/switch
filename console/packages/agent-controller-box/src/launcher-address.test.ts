import { describe, expect, it } from 'vitest';
import { loopbackOffProxy, netOptions, parseLoopback } from './launcher-address';

describe('the launcher address', () => {
  it('takes 127.0.0.1 and a port, and nothing else: loopback inside the pod only', () => {
    expect(parseLoopback('127.0.0.1:7420')).toEqual({ kind: 'loopback', port: 7420 });
    expect(parseLoopback('127.0.0.1:1')).toEqual({ kind: 'loopback', port: 1 });
    expect(parseLoopback('127.0.0.1:65535')).toEqual({ kind: 'loopback', port: 65535 });
    for (const bad of [
      '0.0.0.0:7420',
      '[::]:7420',
      '[::1]:7420',
      'localhost:7420',
      '127.0.0.2:7420',
      '10.0.0.5:7420',
      '127.0.0.1:0',
      '127.0.0.1:65536',
      '127.0.0.1',
      '127.0.0.1:74 20',
      ' 127.0.0.1:7420',
      '',
    ])
      expect(parseLoopback(bad)).toBeNull();
  });

  it('hands net only 127.0.0.1 for a port, or the path', () => {
    expect(netOptions({ kind: 'loopback', port: 7420 })).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(netOptions({ kind: 'path', path: '/run/switch/launcher.sock' })).toEqual({
      path: '/run/switch/launcher.sock',
    });
  });

  it('needs NO_PROXY to cover loopback whenever a proxy is set', () => {
    expect(loopbackOffProxy({})).toBe(true);
    expect(loopbackOffProxy({ HTTPS_PROXY: 'http://proxy:3128' })).toBe(false);
    expect(loopbackOffProxy({ https_proxy: 'http://proxy:3128', NO_PROXY: 'example.com' })).toBe(
      false
    );
    expect(
      loopbackOffProxy({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'example.com, 127.0.0.1' })
    ).toBe(true);
    expect(loopbackOffProxy({ ALL_PROXY: 'socks5://p:1080', no_proxy: 'LOCALHOST' })).toBe(true);
    expect(loopbackOffProxy({ HTTPS_PROXY: '', NO_PROXY: '' })).toBe(true);
  });
});
