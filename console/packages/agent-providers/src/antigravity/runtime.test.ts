import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { noopLogger } from '../transport/stdio-json-rpc';
import { antigravityProfile, antigravitySignedIn, createAntigravityClient } from './runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('records the auth type where every Antigravity ACP version reads it, keeping one already there', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'antigravity-profile-'));
  roots.push(profile);
  await mkdir(join(profile, 'antigravity-acp'), { recursive: true });
  await writeFile(join(profile, 'antigravity-acp', 'settings.json'), '{"auth":{"type":"kept"}}');
  const client = await createAntigravityClient({
    binaryPath: '/bin/true',
    cwd: profile,
    env: { GEMINI_HOME: profile, PATH: '/usr/bin:/bin' },
    logger: noopLogger,
    onExit: () => {},
  });
  await client.dispose();
  expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))).toEqual({
    auth: { type: 'oauth-personal' },
  });
  expect(await readFile(join(profile, 'antigravity-acp', 'settings.json'), 'utf8')).toBe(
    '{"auth":{"type":"kept"}}'
  );
});

it('counts a profile as signed in by the token --login writes, with a refresh token', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'antigravity-token-'));
  roots.push(profile);
  expect(await antigravitySignedIn(profile)).toBe(false);
  await mkdir(join(profile, 'antigravity-acp'), { recursive: true });
  await writeFile(join(profile, 'antigravity-acp', 'acp_token.json'), '{"access_token":"a"}');
  expect(await antigravitySignedIn(profile)).toBe(false);
  await writeFile(
    join(profile, 'antigravity-acp', 'acp_token.json'),
    '{"access_token":"a","refresh_token":"r"}'
  );
  expect(await antigravitySignedIn(profile)).toBe(true);
  expect(antigravityProfile({ GEMINI_HOME: profile, HOME: '/home/x' })).toBe(profile);
});
