import { describe, expect, it } from 'vitest';
import { isHttpsOrLoopback, isUnencryptedRemoteUrl } from './loopback';

describe('isHttpsOrLoopback', () => {
  it('takes https anywhere, and http to this computer', () => {
    expect(isHttpsOrLoopback(new URL('https://switch.example.com'))).toBe(true);
    expect(isHttpsOrLoopback(new URL('http://127.0.0.1:51001'))).toBe(true);
    expect(isHttpsOrLoopback(new URL('http://localhost:3000'))).toBe(true);
    expect(isHttpsOrLoopback(new URL('http://[::1]:3000'))).toBe(true);
  });

  it('refuses http to anywhere else', () => {
    expect(isHttpsOrLoopback(new URL('http://switch.example.com'))).toBe(false);
    expect(isHttpsOrLoopback(new URL('http://192.168.1.10:3000'))).toBe(false);
    expect(isHttpsOrLoopback(new URL('http://127.0.0.1.example.com'))).toBe(false);
  });
});

describe('isUnencryptedRemoteUrl', () => {
  it('flags plain http to another machine', () => {
    expect(isUnencryptedRemoteUrl('http://switch.example.com')).toBe(true);
    expect(isUnencryptedRemoteUrl('http://192.168.1.10:8000')).toBe(true);
  });

  it('leaves https, http to this computer, and what is not an address alone', () => {
    expect(isUnencryptedRemoteUrl('https://switch.example.com')).toBe(false);
    expect(isUnencryptedRemoteUrl('http://127.0.0.1:8000')).toBe(false);
    expect(isUnencryptedRemoteUrl('http://localhost:8000')).toBe(false);
    expect(isUnencryptedRemoteUrl('http://[::1]:8000')).toBe(false);
    expect(isUnencryptedRemoteUrl('not a url')).toBe(false);
  });
});
