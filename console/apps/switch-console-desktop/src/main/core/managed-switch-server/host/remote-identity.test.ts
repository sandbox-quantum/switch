import { describe, expect, it } from 'vitest';
import { hostSlug, remoteSecretsKey } from './remote-identity';

describe('hostSlug', () => {
  it('keeps safe characters and replaces the rest', () => {
    expect(hostSlug('prod-box')).toBe('prod-box');
    expect(hostSlug('user@1.2.3.4')).toBe('user_1.2.3.4');
    expect(hostSlug('host with spaces/and:colons')).toBe('host_with_spaces_and_colons');
  });
});

describe('remoteSecretsKey', () => {
  it('namespaces the key per host slug', () => {
    expect(remoteSecretsKey('prod-box')).toBe('remote-switch-server:prod-box:secrets');
    expect(remoteSecretsKey('user@1.2.3.4')).toBe('remote-switch-server:user_1.2.3.4:secrets');
  });

  it('is distinct across hosts', () => {
    expect(remoteSecretsKey('a')).not.toBe(remoteSecretsKey('b'));
  });
});
