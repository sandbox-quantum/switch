import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const appData = vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'switch-console-app-data-'));
});

vi.mock('electron', async () => {
  const root = await appData;
  const paths = new Map<string, string>([['appData', root]]);
  return {
    app: {
      setName: vi.fn(),
      getPath: (name: string) => paths.get(name),
      setPath: (name: string, value: string) => paths.set(name, value),
    },
  };
});
vi.mock('./user-data-dir', () => ({ userDataDirName: () => 'console-data' }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const root = await appData;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === 'win32')(
  'makes an existing data folder readable by this user alone',
  async () => {
    const userData = join(root, 'console-data');
    mkdirSync(userData, { mode: 0o755 });
    chmodSync(userData, 0o755);

    await import('./configure-app-identity');

    expect(statSync(userData).mode & 0o777).toBe(0o700);
  }
);
