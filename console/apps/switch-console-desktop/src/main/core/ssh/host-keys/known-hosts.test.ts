import { describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  formatKnownHostsLine,
  hostKeyName,
  keyTypeOf,
  lineMatchesHost,
  lookupHostKey,
  parseKnownHosts,
  preferredServerHostKeyAlgorithms,
} from './known-hosts';

// Public keys generated with ssh-keygen; the fingerprints are what
// `ssh-keygen -lf` printed for them.
const ECDSA_KEY =
  'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBL35V37bjh3iydavEvI3yTukYEfLXWS7Azj0uDe59ibMCnv0TVCV9mDQosagf25KploGgj0xNLQy7xKp4TGwms4=';
const ECDSA_FINGERPRINT = 'SHA256:KV43P+dJ5FayHacqfRebOdQ8PKYGi3qDfeLWRSeYWHM';
const ED25519_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIHfmPZbF5uZU7oI6xn1x5/g1EWdWSda4EGM8usolvBTJ';
const ED25519_FINGERPRINT = 'SHA256:gyeh6ez3iwWbkCNmvc5IqY38r+x6di4UlzDXojVareE';
// `ssh-keygen -H` output for "[example.test]:2222 ecdsa-sha2-nistp256 <ECDSA_KEY>".
const HASHED_LINE = `|1|emFJiDL2M/5yt0y3/MLFfpJgcxg=|4NKPc/phZhIWAG6zSw/C4Y2uxms= ecdsa-sha2-nistp256 ${ECDSA_KEY}`;

const ecdsa = Buffer.from(ECDSA_KEY, 'base64');
const ed25519 = Buffer.from(ED25519_KEY, 'base64');

describe('known_hosts', () => {
  it('computes the same fingerprint and key type as OpenSSH', () => {
    expect(fingerprintOf(ecdsa)).toBe(ECDSA_FINGERPRINT);
    expect(fingerprintOf(ed25519)).toBe(ED25519_FINGERPRINT);
    expect(keyTypeOf(ecdsa)).toBe('ecdsa-sha2-nistp256');
  });

  it('names a host the way OpenSSH records it', () => {
    expect(hostKeyName('Build.Example.test', 22, undefined)).toBe('build.example.test');
    expect(hostKeyName('build.example.test', 2222, undefined)).toBe('[build.example.test]:2222');
    expect(hostKeyName('10.0.0.5', 2222, 'Build-Box')).toBe('build-box');
  });

  it('matches a hashed entry written by ssh-keygen -H', () => {
    const [line] = parseKnownHosts(HASHED_LINE, 'known_hosts');
    expect(line).toBeDefined();
    expect(lineMatchesHost(line!, '[example.test]:2222')).toBe(true);
    expect(lineMatchesHost(line!, 'example.test')).toBe(false);
    expect(lineMatchesHost(line!, '[example.test]:2223')).toBe(false);
    expect(lookupHostKey([line!], '[example.test]:2222', ecdsa)).toEqual({ status: 'match' });
  });

  it('matches comma lists, wildcards and negations, case-insensitively', () => {
    const [line] = parseKnownHosts(
      `Build.example.test,*.dev.example.test,!secret.dev.example.test,[10.0.0.?]:2222 ssh-ed25519 ${ED25519_KEY}`,
      'known_hosts'
    );
    expect(lineMatchesHost(line!, 'build.example.test')).toBe(true);
    expect(lineMatchesHost(line!, 'vm1.dev.example.test')).toBe(true);
    expect(lineMatchesHost(line!, 'secret.dev.example.test')).toBe(false);
    expect(lineMatchesHost(line!, '[10.0.0.7]:2222')).toBe(true);
    expect(lineMatchesHost(line!, '10.0.0.7')).toBe(false);
    expect(lineMatchesHost(line!, 'other.example.test')).toBe(false);
  });

  it('skips comments, blank lines, unknown markers, RSA1 entries and mismatched blobs', () => {
    const lines = parseKnownHosts(
      [
        '# comment',
        '',
        `@unknown host ssh-ed25519 ${ED25519_KEY}`,
        'host 2048 35 1234567',
        `host ssh-rsa ${ED25519_KEY}`,
        `host ssh-ed25519 ${ED25519_KEY} trailing comment`,
      ].join('\n'),
      '/home/u/.ssh/known_hosts'
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.source).toBe('/home/u/.ssh/known_hosts:6');
  });

  it('accepts a recorded key, calls any other recorded key a change, and refuses a revoked one', () => {
    const lines = parseKnownHosts(
      [
        `build.example.test ssh-ed25519 ${ED25519_KEY}`,
        `@revoked * ecdsa-sha2-nistp256 ${ECDSA_KEY}`,
      ].join('\n'),
      'kh'
    );
    expect(lookupHostKey(lines, 'build.example.test', ed25519)).toEqual({ status: 'match' });
    expect(lookupHostKey(lines, 'build.example.test', ecdsa)).toEqual({
      status: 'revoked',
      known: [{ keyType: 'ecdsa-sha2-nistp256', fingerprint: ECDSA_FINGERPRINT, source: 'kh:2' }],
    });

    const unrevoked = parseKnownHosts(`build.example.test ecdsa-sha2-nistp256 ${ECDSA_KEY}`, 'kh');
    expect(lookupHostKey(unrevoked, 'build.example.test', ed25519)).toEqual({
      status: 'changed',
      known: [{ keyType: 'ecdsa-sha2-nistp256', fingerprint: ECDSA_FINGERPRINT, source: 'kh:1' }],
    });
    expect(lookupHostKey(unrevoked, 'other.example.test', ed25519)).toEqual({ status: 'unknown' });
  });

  it('ignores @cert-authority lines: ssh2 does not negotiate host certificates', () => {
    const lines = parseKnownHosts(
      `@cert-authority *.example.test ssh-ed25519 ${ED25519_KEY}`,
      'kh'
    );
    expect(lookupHostKey(lines, 'build.example.test', ed25519)).toEqual({ status: 'unknown' });
  });

  it('prefers the host key algorithms already on record for the host', () => {
    const lines = parseKnownHosts(`build.example.test ecdsa-sha2-nistp256 ${ECDSA_KEY}`, 'kh');
    expect(preferredServerHostKeyAlgorithms(lines, 'build.example.test')[0]).toBe(
      'ecdsa-sha2-nistp256'
    );
    expect(preferredServerHostKeyAlgorithms(lines, 'other.example.test')[0]).toBe('ssh-ed25519');
  });

  it('writes a line that parses back to the same key', () => {
    const text = formatKnownHostsLine('[build.example.test]:2222', ed25519);
    expect(text).toBe(`[build.example.test]:2222 ssh-ed25519 ${ED25519_KEY}`);
    const lines = parseKnownHosts(text, 'kh');
    expect(lookupHostKey(lines, '[build.example.test]:2222', ed25519)).toEqual({ status: 'match' });
  });
});
