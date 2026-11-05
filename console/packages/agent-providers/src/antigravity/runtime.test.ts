import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  antigravityLaunch,
  antigravityProfile,
  antigravitySignedIn,
  isLegacyAntigravityRuntime,
} from './runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('runs agy as `agy acp` in the user’s own profile, on every OS', async () => {
  for (const binaryPath of [
    'agy',
    '/home/u/.local/bin/agy',
    '/Users/u/.local/bin/agy',
    'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe',
  ]) {
    const launch = await antigravityLaunch({
      binaryPath,
      cwd: '/work',
      env: { HOME: '/home/u', PATH: '/usr/bin' },
      mcpServers: {},
    });
    expect(launch).toEqual({
      command: binaryPath,
      args: ['acp'],
      env: { HOME: '/home/u', PATH: '/usr/bin', BROWSER: 'false' },
    });
  }
});

it('refuses the Antigravity IDE launcher, which would take `acp` for a folder to open', async () => {
  for (const binaryPath of [
    'antigravity',
    '/usr/bin/antigravity',
    'C:\\Users\\u\\AppData\\Local\\Programs\\Antigravity\\bin\\antigravity.cmd',
  ])
    await expect(
      antigravityLaunch({ binaryPath, cwd: '/work', env: {}, mcpServers: {} })
    ).rejects.toThrow('Antigravity IDE launcher');
});

it('tells a legacy wrapper install from Google’s agy', () => {
  expect(isLegacyAntigravityRuntime('/home/u/.local/bin/antigravity-acp')).toBe(true);
  expect(isLegacyAntigravityRuntime('/opt/acp/agy_acp_server.par')).toBe(true);
  expect(isLegacyAntigravityRuntime('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe')).toBe(false);
  expect(isLegacyAntigravityRuntime('agy')).toBe(false);
});

it('records the auth type where every Antigravity ACP version reads it, keeping one already there', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'antigravity-profile-'));
  roots.push(profile);
  await mkdir(join(profile, 'antigravity-acp'), { recursive: true });
  await writeFile(join(profile, 'antigravity-acp', 'settings.json'), '{"auth":{"type":"kept"}}');
  await antigravityLaunch({
    binaryPath: '/home/u/.local/bin/antigravity-acp',
    cwd: profile,
    env: { GEMINI_HOME: profile, PATH: '/usr/bin:/bin' },
    mcpServers: {},
  });
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
