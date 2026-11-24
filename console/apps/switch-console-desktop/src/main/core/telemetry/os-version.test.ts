import { describe, expect, it } from 'vitest';
import { coarseOsVersion } from './os-version';

describe('the operating system version sent', () => {
  it('is major.minor on macOS', () => {
    expect(coarseOsVersion('darwin', '23.6.0')).toBe('23.6');
    expect(coarseOsVersion('darwin', '25.0.0')).toBe('25.0');
  });

  it('keeps no Windows build number', () => {
    expect(coarseOsVersion('win32', '10.0.22631')).toBe('10');
  });

  it('keeps no Linux patch level or distribution flavour', () => {
    expect(coarseOsVersion('linux', '6.1.0-53-cloud-amd64')).toBe('6');
    expect(coarseOsVersion('linux', '5.15.153.1-microsoft-standard-WSL2')).toBe('5');
  });

  it('is major.0 on macOS when the release has no minor', () => {
    expect(coarseOsVersion('darwin', '24')).toBe('24.0');
  });

  it('is unknown rather than an unrecognised string passed through', () => {
    expect(coarseOsVersion('linux', 'custom-kernel')).toBe('unknown');
    expect(coarseOsVersion('freebsd', '')).toBe('unknown');
  });
});
