import { describe, expect, it } from 'vitest';
import {
  BOX_MARKER_PATH,
  BoxModeMismatch,
  hostBoxMode,
  insideBox,
  resolveControllerBoxMode,
} from './box-mode';

describe('box mode', () => {
  const marker = (over: Partial<{ file: boolean; uid: number; mode: number }> = {}) => {
    const { file = true, uid = 0, mode = 0o100444 } = over;
    return (path: string) => {
      if (path !== BOX_MARKER_PATH) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => file, uid, mode };
    };
  };

  it('is inside a box only with the image marker: on Linux, a root-owned regular file nobody else can write', () => {
    expect(insideBox({ platform: 'linux', lstat: marker() })).toBe(true);
    expect(insideBox({ platform: 'linux', lstat: marker({ mode: 0o100644 }) })).toBe(true);
    expect(BOX_MARKER_PATH).toBe('/etc/switch/box');
  });

  it('counts anything else as not a box', () => {
    const gone = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(insideBox({ platform: 'linux', lstat: gone })).toBe(false);
    expect(insideBox({ platform: 'linux', lstat: marker({ uid: 1000 }) })).toBe(false); // not root's
    expect(insideBox({ platform: 'linux', lstat: marker({ mode: 0o100464 }) })).toBe(false); // group-writable
    expect(insideBox({ platform: 'linux', lstat: marker({ mode: 0o100446 }) })).toBe(false); // others-writable
    expect(insideBox({ platform: 'linux', lstat: marker({ file: false }) })).toBe(false); // a link or folder
    for (const platform of ['win32', 'darwin'] as const)
      expect(insideBox({ platform, lstat: marker() })).toBe(false); // a marker off Linux proves nothing
  });

  it('reads the real marker path with lstat by default', () => {
    // This test machine is no box image.
    expect(insideBox()).toBe(false);
  });

  it('runs the controller in box mode only with --box and the marker', () => {
    expect(resolveControllerBoxMode(true, true)).toBe(true);
    expect(resolveControllerBoxMode(false, false)).toBe(false); // desktop and v1, unchanged
    expect(() => resolveControllerBoxMode(false, true)).toThrow(BoxModeMismatch); // a box without --box
    expect(() => resolveControllerBoxMode(true, false)).toThrow(BoxModeMismatch); // --box outside a box
  });

  it('takes the host from the marker, and a config can only add a refusal', () => {
    expect(hostBoxMode(true, true)).toBe(true);
    expect(hostBoxMode(false, true)).toBe(true); // nothing an agent writes turns box mode off
    expect(hostBoxMode(false, false)).toBe(false); // desktop and v1
    expect(() => hostBoxMode(true, false)).toThrow(BoxModeMismatch); // marker gone: refuse on restart
  });
});
