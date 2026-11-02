import { afterEach, describe, expect, it } from 'vitest';
import { dirMode, fileMode, SHARED_GROUP_ENV } from './host-permissions';

afterEach(() => {
  delete process.env[SHARED_GROUP_ENV];
});

describe('host permissions', () => {
  it('keeps what an agent host writes private by default', () => {
    expect(fileMode(0o600)).toBe(0o600);
    expect(dirMode(0o700)).toBe(0o700);
  });

  it('opens it to the group under the shared group, with no set-id bit', () => {
    process.env[SHARED_GROUP_ENV] = '1';
    expect(fileMode(0o600)).toBe(0o640);
    expect(dirMode(0o700)).toBe(0o770);
  });
});
