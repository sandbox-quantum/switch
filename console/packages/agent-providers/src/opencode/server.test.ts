import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startOpencodeServer } from './server';

it('aborts a provider that has not announced readiness and waits for its exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-start-abort-'));
  const binary = join(root, 'provider');
  const pidFile = join(root, 'pid');
  await writeFile(
    binary,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_PID_FILE, String(process.pid));setInterval(() => {}, 1000);\n`,
    { mode: 0o700 }
  );
  const controller = new AbortController();
  const starting = startOpencodeServer({
    binaryPath: binary,
    cwd: root,
    env: { ...process.env, TEST_PID_FILE: pidFile } as Record<string, string>,
    config: { $schema: 'https://opencode.ai/config.json', permission: {}, mcp: {} },
    skills: [],
    startupTimeoutMs: 60000,
    signal: controller.signal,
  });
  const result = starting.catch((error: unknown) => error);
  try {
    await vi.waitFor(
      async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0),
      { timeout: 5000 }
    );
    const pid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await result;
    await rm(root, { recursive: true, force: true });
  }
});
