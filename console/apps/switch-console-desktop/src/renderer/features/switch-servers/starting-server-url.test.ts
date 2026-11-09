import { describe, expect, it } from 'vitest';
import { startingServerUrl } from './starting-server-url';

const DEFAULT = 'https://test-server.example';

describe('startingServerUrl', () => {
  it('starts a new server at the build default', () => {
    expect(startingServerUrl(null, null, false, DEFAULT)).toBe(DEFAULT);
  });

  it('starts empty on a build with no default', () => {
    expect(startingServerUrl(null, null, false, null)).toBe('');
  });

  it('keeps an address the wizard was given', () => {
    expect(startingServerUrl('https://given.example', null, false, DEFAULT)).toBe(
      'https://given.example'
    );
  });

  it('keeps the address of a server being fixed', () => {
    expect(startingServerUrl(null, 'https://mine.example', false, DEFAULT)).toBe(
      'https://mine.example'
    );
  });

  it('never fills in the default when editing a server', () => {
    expect(startingServerUrl(null, null, true, DEFAULT)).toBe('');
  });
});
