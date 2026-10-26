import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent } from '../events';
import { createCodexAdapter } from './codex-adapter';
import { CODEX_KEYRING_READ_TIMEOUT_MS, readCodexKeyringApiKey } from './keyring-login';

/**
 * The handoff against the real `codex` binary, with a made-up key and nothing
 * in the OS keyring: the source home keeps the key in auth.json, which Codex
 * exports the same way as a keyring login. Reading a real keychain entry is
 * the one part left to a manual check, as it writes to the developer's
 * keychain. The turn reaches OpenAI, whose 401 for the key is what proves the
 * session used it.
 */
const FAKE_KEY = 'sk-fake-switch-keyring-handoff-0000';

const unavailable = (() => {
  const probe = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  return probe.error || probe.status !== 0;
})();

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe.skipIf(unavailable)('Codex keyring login handoff (real codex)', () => {
  let root: string;
  let sourceHome: string;
  let sessionHome: string;
  let work: string;
  const env = () => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CODEX_HOME: sessionHome,
  });

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-keyring-handoff-')));
    sourceHome = join(root, 'source');
    sessionHome = join(root, 'session');
    work = join(root, 'work');
    await mkdir(sourceHome);
    await writeFile(join(sourceHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }));
    // The session's own configuration, and a trusted project's, both ask for
    // a file: the command line has to outrank them.
    await mkdir(sessionHome);
    await writeFile(
      join(sessionHome, 'config.toml'),
      `cli_auth_credentials_store = "file"\n[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`
    );
    await mkdir(join(work, '.codex'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: work });
    await writeFile(join(work, '.codex', 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('exports an API-key login through getAuthStatus', async () => {
    const key = await readCodexKeyringApiKey(
      'codex',
      { home: sourceHome, env: env(), redact: () => {} },
      CODEX_KEYRING_READ_TIMEOUT_MS
    );
    expect(key).toBe(FAKE_KEY);
  });

  it(
    'signs the session in from memory, writes the key nowhere, and sends it with the turn',
    { timeout: 120_000 },
    async () => {
      const adapter = createCodexAdapter();
      const events: ProviderRuntimeEvent[] = [];
      adapter.subscribe((event) => events.push(event));
      const redact = vi.fn();
      try {
        await adapter.startSession({
          sessionId: 'keyring-handoff',
          cwd: work,
          runtimeMode: 'full-access',
          env: env(),
          mcpServers: {},
          connectorMcpServers: [],
          codexKeyringLogin: { home: sourceHome, env: env(), redact },
        });
        expect(redact).toHaveBeenCalledWith(FAKE_KEY);
        await adapter.sendTurn({ sessionId: 'keyring-handoff', turnId: 'turn-1', text: 'hi' });
        const done = await new Promise<Extract<ProviderRuntimeEvent, { type: 'turn.completed' }>>(
          (resolve) => {
            const check = () => {
              const found = events.find(
                (event): event is Extract<ProviderRuntimeEvent, { type: 'turn.completed' }> =>
                  event.type === 'turn.completed'
              );
              if (found) resolve(found);
              else setTimeout(check, 250);
            };
            check();
          }
        );
        expect(done.outcome).toBe('error');
        expect(done.message).toMatch(/401|Incorrect API key/);
      } finally {
        await adapter.stopAll();
      }
      expect(await readdir(sessionHome)).not.toContain('auth.json');
      for (const file of await filesUnder(sessionHome))
        expect((await readFile(file)).includes(FAKE_KEY), file).toBe(false);
    }
  );
});
