import { describe, expect, it } from 'vitest';
import { linuxPasswordStoreFallback } from './linux-password-store';

describe('linuxPasswordStoreFallback', () => {
  it('asks for the Secret Service when there is no desktop environment', () => {
    expect(linuxPasswordStoreFallback({}, false)).toBe('gnome-libsecret');
  });

  it('leaves the choice to Chromium under a desktop environment', () => {
    expect(linuxPasswordStoreFallback({ XDG_CURRENT_DESKTOP: 'KDE' }, false)).toBeNull();
  });

  it('keeps a --password-store the launch passed', () => {
    expect(linuxPasswordStoreFallback({}, true)).toBeNull();
  });
});
