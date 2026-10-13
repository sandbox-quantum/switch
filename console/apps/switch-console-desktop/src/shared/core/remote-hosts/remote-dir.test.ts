import { describe, expect, it } from 'vitest';
import { isAbsoluteMachineDir } from './remote-dir';

describe('isAbsoluteMachineDir', () => {
  it('takes a drive or a share as absolute on a Windows machine', () => {
    expect(isAbsoluteMachineDir('C:\\Users\\me\\work', 'windows')).toBe(true);
    expect(isAbsoluteMachineDir('d:/work', 'windows')).toBe(true);
    expect(isAbsoluteMachineDir('\\\\server\\share\\work', 'windows')).toBe(true);
    expect(isAbsoluteMachineDir('C:work', 'windows')).toBe(false);
    expect(isAbsoluteMachineDir('work', 'windows')).toBe(false);
  });

  it('wants a rooted path elsewhere, and where the system is not known', () => {
    expect(isAbsoluteMachineDir('/home/me/work', 'linux')).toBe(true);
    expect(isAbsoluteMachineDir('C:\\work', 'macos')).toBe(false);
    expect(isAbsoluteMachineDir('C:\\work', null)).toBe(false);
  });
});
