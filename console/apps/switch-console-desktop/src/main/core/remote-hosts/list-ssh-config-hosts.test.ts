import { describe, expect, it } from 'vitest';
import { parseSshConfigHosts } from './list-ssh-config-hosts';

describe('parseSshConfigHosts', () => {
  it('returns concrete host aliases, sorted and de-duplicated', () => {
    const config = `
      Host dev-vm
        HostName 10.0.0.1
        User agent

      Host build-box prod-box
        HostName example.com
    `;
    expect(parseSshConfigHosts(config)).toEqual(['build-box', 'dev-vm', 'prod-box']);
  });

  it('skips wildcard and negated pattern entries', () => {
    const config = ['Host *', 'Host *.internal', 'Host !excluded', 'Host real-host'].join('\n');
    expect(parseSshConfigHosts(config)).toEqual(['real-host']);
  });

  it('ignores comments and blank lines and is case-insensitive on the keyword', () => {
    const config = ['# a comment', '', 'HOST my-host', '  # indented comment'].join('\n');
    expect(parseSshConfigHosts(config)).toEqual(['my-host']);
  });

  it('returns an empty array for config with no host entries', () => {
    expect(parseSshConfigHosts('HostName nope\nUser someone')).toEqual([]);
  });
});
