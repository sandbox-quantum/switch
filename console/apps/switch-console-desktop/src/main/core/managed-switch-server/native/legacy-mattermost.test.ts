import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeLayout } from './native-paths';

const m = vi.hoisted(() => ({
  detect: vi.fn(),
  run: vi.fn(),
}));
vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../docker', () => ({ detectDocker: m.detect, dockerExecutable: () => 'docker' }));
vi.mock('./run-command', () => ({ runCommand: m.run }));

const { removeLegacyMattermost } = await import('./legacy-mattermost');

async function withLegacyFiles() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'legacy-mm-'));
  const layout = nativeLayout(dir);
  await mkdir(layout.root, { recursive: true });
  const compose = path.join(layout.root, 'mattermost-compose.yml');
  const settings = path.join(dir, 'mattermost.json');
  await writeFile(compose, 'services: {}\n');
  await writeFile(settings, '{"enabled":true}\n');
  return { layout, compose, settings };
}

describe('removeLegacyMattermost', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.detect.mockResolvedValue({ available: true, version: '27.0.0' });
    m.run.mockResolvedValue(undefined);
  });

  it('takes the containers down, keeping volumes, then forgets the files', async () => {
    const { layout, compose, settings } = await withLegacyFiles();

    await removeLegacyMattermost(layout);

    const args = m.run.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['compose', 'down']));
    expect(args).not.toContain('-v');
    expect(existsSync(compose)).toBe(false);
    expect(existsSync(settings)).toBe(false);
  });

  it('keeps the files to try again when the containers could not be removed', async () => {
    const { layout, compose } = await withLegacyFiles();
    m.run.mockRejectedValue(new Error('daemon gone'));

    await expect(removeLegacyMattermost(layout)).resolves.toBeUndefined();

    expect(existsSync(compose)).toBe(true);
  });

  it('does nothing without Docker', async () => {
    const { layout, compose } = await withLegacyFiles();
    m.detect.mockResolvedValue({ available: false, reason: 'not-installed', detail: 'none' });

    await removeLegacyMattermost(layout);

    expect(m.run).not.toHaveBeenCalled();
    expect(existsSync(compose)).toBe(true);
  });

  it('asks nothing of Docker when no Mattermost was ever run', async () => {
    const layout = nativeLayout(await mkdtemp(path.join(os.tmpdir(), 'legacy-mm-')));

    await removeLegacyMattermost(layout);

    expect(m.detect).not.toHaveBeenCalled();
  });
});
