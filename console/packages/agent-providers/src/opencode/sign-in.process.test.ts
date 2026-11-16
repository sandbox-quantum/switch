import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProviderReadiness } from '../host/provider-readiness';

const AS_1X = `if (process.argv.includes('--version')) { console.log('1.19.5'); process.exit(0); }\n`;

// A stand-in for OpenCode 1.x's `opencode serve`: says it is listening, then
// answers the two routes the sign-in check asks.
const FAKE_SERVE =
  AS_1X +
  `
const http = require('node:http');
const port = Number(process.argv.find((arg) => arg.startsWith('--port=')).slice(7));
http
  .createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/global/health') return response.end('{"healthy":true}');
    if (request.url === '/provider') return response.end('{"connected":["openrouter"]}');
    response.statusCode = 404;
    response.end('{}');
  })
  .listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
`;

const FAILING_SERVE =
  AS_1X +
  `
console.log('starting');
console.error('boom: the config could not be read');
process.exit(3);
`;

// A stand-in for OpenCode 2.x, which lists its providers from a private server.
const FAKE_2X = `
if (process.argv.includes('--version')) { console.log('opencode v2.3.0'); process.exit(0); }
if (process.argv.join(' ').includes('api --standalone provider.list'))
  console.log(JSON.stringify({ data: [
    { id: 'opencode', name: 'OpenCode', settings: { apiKey: 'public' } },
    { id: 'openrouter', name: 'OpenRouter', settings: {} },
  ] }));
else process.exit(2);
`;

const FAKE_3X = `console.log('opencode v3.0.0');`;

let root: string;
beforeEach(() => {
  // Spaces where a Windows user's profile and an install folder have them.
  root = mkdtempSync(join(tmpdir(), 'opencode sign-in '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An OpenCode CLI installed the way npm does it: a `.cmd` launcher on Windows. */
function installCli(script: string): string {
  const bin = join(root, 'KRISHNA ASWANI T', 'AppData', 'Roaming', 'npm');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'opencode.js'), script);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n');
    writeFileSync(
      join(bin, 'opencode.cmd'),
      `@ECHO off\r\n"${process.execPath}" "%~dp0\\opencode.js" %*\r\n`
    );
    return join(bin, 'opencode.CMD');
  }
  writeFileSync(join(bin, 'opencode'), `#!${process.execPath}\n${script}`);
  chmodSync(join(bin, 'opencode'), 0o755);
  return join(bin, 'opencode');
}

function check(binaryPath: string) {
  const cwd = join(root, 'servers', 'one two');
  mkdirSync(cwd, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])
  );
  return checkProviderReadiness({
    provider: 'opencode',
    binaryPath,
    cwd,
    env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, 'config home') },
  });
}

describe('the OpenCode sign-in check, with spaces in every path', () => {
  it('starts the CLI and reads its connected backends', async () => {
    expect((await check(installCli(FAKE_SERVE))).status).toBe('authenticated');
  }, 60_000);

  it('asks OpenCode 2 for its providers', async () => {
    const result = await check(installCli(FAKE_2X));
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('OpenRouter');
  }, 60_000);

  it('says a version it cannot drive is unsupported, without offering a sign-in', async () => {
    const result = await check(installCli(FAKE_3X));
    expect(result.status).toBe('unknown');
    expect(result.loginHelps).toBe(false);
    expect(result.message).toContain('OpenCode 3.0.0 is newer than this version of Switch Console');
  }, 60_000);

  it('says what the CLI printed when it does not start', async () => {
    const result = await check(installCli(FAILING_SERVE));
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('server exited with code 3');
    expect(result.message).toContain('boom: the config could not be read');
  }, 60_000);
});
