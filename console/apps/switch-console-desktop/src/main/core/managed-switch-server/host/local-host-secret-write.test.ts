import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = await mkdtemp(join(tmpdir(), 'switch-local-server-'));

vi.mock('../paths', () => ({ localServerDir: () => dir }));
vi.mock('../docker', () => ({ detectDocker: vi.fn(), dockerExecutable: () => 'docker' }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { LocalServerHost } = await import('./local-host');

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the local managed server', () => {
  it('replaces an existing world-readable .env rather than writing secrets into it', async () => {
    const path = join(dir, '.env');
    await writeFile(path, 'OLD=1\n', { mode: 0o644 });
    const before = await stat(path);

    await new LocalServerHost().writeFile('.env', 'DB_PASSWORD=fake\n', 0o600);

    const after = await stat(path);
    expect(after.mode & 0o777).toBe(0o600);
    // A new file renamed into place, not the old 0644 one rewritten.
    expect(after.ino).not.toBe(before.ino);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await expect(readFile(path, 'utf-8')).resolves.toBe('DB_PASSWORD=fake\n');
  });
});
