import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProviderReadiness } from '../host/provider-readiness';

// A stand-in for `opencode serve`: says it is listening, then answers the two
// routes the sign-in check asks.
const FAKE_SERVE = `
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

const FAILING_SERVE = `
console.log('starting');
console.error('boom: the config could not be read');
process.exit(3);
`;

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

  it('says what the CLI printed when it does not start', async () => {
    const result = await check(installCli(FAILING_SERVE));
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('server exited with code 3');
    expect(result.message).toContain('boom: the config could not be read');
  }, 60_000);
});
