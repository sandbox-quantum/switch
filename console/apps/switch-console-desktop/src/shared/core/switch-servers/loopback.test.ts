import { describe, expect, it } from 'vitest';
import { isHttpsOrLoopback } from './loopback';

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
