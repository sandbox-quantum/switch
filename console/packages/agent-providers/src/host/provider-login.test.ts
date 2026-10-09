import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerLoginEnvironment } from './provider-login';
import { readProviderLogin, type SharedHostConfig } from './shared-config';

const login = {
  status: 'connected' as const,
  provider: 'claude' as const,
  revision: '1',
  kind: 'setup-token' as const,
  credential: 'sk-ant-oat-given',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provider-login-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(provider: string): SharedHostConfig {
  return {
    start: { provider },
    session: { agentId: 'agent-1' },
    execution: { credentialsPath: join(dir, 'credentials.json') },
  } as unknown as SharedHostConfig;
}

describe('provider logins handed to an agent host', () => {
  it('reads the login its controller hands over with its credentials', async () => {
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ env: {}, providerLogin: login })
    );
    expect(await readProviderLogin(config('claude'))).toEqual(login);
    await expect(readProviderLogin(config('codex'))).rejects.toThrow(/another provider/);
    await writeFile(join(dir, 'credentials.json'), JSON.stringify({ env: {} }));
    expect(await readProviderLogin(config('claude'))).toBeNull();
  });

  it('gives sessions the token, or the directory the login file is written in', () => {
    expect(providerLoginEnvironment('/root', login)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given',
    });
    expect(providerLoginEnvironment('/root', { ...login, kind: 'api-key' })).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-oat-given',
    });
    expect(
      providerLoginEnvironment('/root', { ...login, provider: 'codex', kind: 'auth-json' })
    ).toEqual({ CODEX_HOME: '/root/provider-home' });
    expect(
      providerLoginEnvironment('/root', { ...login, provider: 'opencode', kind: 'auth-json' })
    ).toEqual({ XDG_DATA_HOME: '/root/provider-data' });
  });
});
