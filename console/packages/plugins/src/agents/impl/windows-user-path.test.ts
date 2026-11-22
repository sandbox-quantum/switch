import { describe, expect, it } from 'vitest';
import { addToUserPath } from './windows-user-path';

describe('addToUserPath', () => {
  const script = addToUserPath('.local', 'bin');

  it('names the folder under the profile and passes through either shell untouched', () => {
    expect(script).toContain("[Environment]::GetFolderPath('UserProfile'), '.local', 'bin'");
    expect(script).not.toMatch(/[$%"]/);
  });

  it('keeps the PATH unexpanded and expandable', () => {
    expect(script).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
    expect(script).toContain("'ExpandString')");
    expect(script).not.toContain("GetEnvironmentVariable('Path'");
    expect(script).not.toContain("SetEnvironmentVariable('Path'");
  });

  it('matches an existing entry with a trailing backslash', () => {
    expect(script).toContain(".Split(';').TrimEnd('\\')");
  });
});
