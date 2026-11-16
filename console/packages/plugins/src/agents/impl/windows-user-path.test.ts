import { describe, expect, it } from 'vitest';
import { addToUserPath } from './windows-user-path';

describe('addToUserPath', () => {
  it('names the folder under the profile and passes through either shell untouched', () => {
    const script = addToUserPath('.local', 'bin');
    expect(script).toContain("[Environment]::GetFolderPath('UserProfile'), '.local', 'bin'");
    expect(script).toContain("SetEnvironmentVariable('Path'");
    expect(script).not.toMatch(/[$%"]/);
  });
});
