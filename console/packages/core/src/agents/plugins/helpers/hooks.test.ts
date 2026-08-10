import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { filterUserHooks, makeStdinHookCommand, SWITCHDASH_MARKER } from './hooks';

const execFileAsync = promisify(execFile);

/**
 * Run `sh -c command` with `stdin` delivered on fd 0 and then closed, mirroring
 * how an agent host feeds a hook its event payload. `execFile` cannot do this —
 * it has no stdin input option, so a command that reads fd 0 would hang.
 */
function runSh(command: string, env: NodeJS.ProcessEnv, stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin.end(stdin);
  });
}

/**
 * Run a POSIX hook command under a real `sh` with `curl` stubbed out, and report
 * what it would have posted. Both the endpoint resolution and the payload
 * plumbing are shell code, so asserting on the string alone would not catch a
 * quoting mistake or a pipeline that runs an assignment in a subshell — only
 * executing it does.
 *
 * Exported so provider packages can point it at the command strings their own
 * hook config writes.
 */
export async function runHookCommand(
  command: string,
  { env, stdin }: { env: Record<string, string>; stdin?: string }
): Promise<{ url: string; token: string; body: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hook-cmd-'));
  try {
    // A `curl` that records its own argv — and, when the command asked it to
    // read the request body from stdin, that body too.
    const stub = path.join(dir, 'curl');
    const argvOut = path.join(dir, 'argv');
    const bodyOut = path.join(dir, 'body');
    await writeFile(
      stub,
      '#!/bin/sh\n' +
        `printf '%s\\n' "$@" > ${JSON.stringify(argvOut)}\n` +
        `for a in "$@"; do [ "$a" = "@-" ] && cat > ${JSON.stringify(bodyOut)}; done\n` +
        'exit 0\n',
      { mode: 0o755 }
    );
    await writeFile(bodyOut, '');

    await runSh(command, { ...env, PATH: `${dir}:${process.env.PATH ?? ''}` }, stdin ?? '');

    const { stdout } = await execFileAsync('cat', [argvOut]);
    const argv = stdout.split('\n');
    const url = argv.find((a) => a.startsWith('http://')) ?? '';
    const tokenIdx = argv.findIndex((a) => a.startsWith('X-Switchdash-Token:'));
    const { stdout: body } = await execFileAsync('cat', [bodyOut]);
    return { url, token: argv[tokenIdx]?.replace('X-Switchdash-Token: ', '') ?? '', body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function resolveEndpoint(
  env: Record<string, string>
): Promise<{ url: string; token: string }> {
  return runHookCommand(makeStdinHookCommand('notification', { platform: 'linux' }), { env });
}

describe('makeStdinHookCommand endpoint resolution', () => {
  it('uses the env port and token when no endpoint file is configured', async () => {
    const { url, token } = await resolveEndpoint({
      SWITCHDASH_HOOK_PORT: '5001',
      SWITCHDASH_HOOK_TOKEN: 'env-token',
      SWITCHDASH_PTY_ID: 'claude:s1',
    });

    expect(url).toBe('http://127.0.0.1:5001/hook');
    expect(token).toBe('env-token');
  });

  it('prefers the endpoint file, so a pane follows a restarted sidecar', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hook-ep-'));
    const endpointFile = path.join(dir, 'endpoint');
    // What the sidecar rewrites after rebinding on a fresh port + token.
    await writeFile(endpointFile, '6002\nfresh-token\n');

    try {
      const { url, token } = await resolveEndpoint({
        // Stale values baked into the pane at spawn time.
        SWITCHDASH_HOOK_PORT: '5001',
        SWITCHDASH_HOOK_TOKEN: 'stale-token',
        SWITCHDASH_PTY_ID: 'claude:s1',
        SWITCHDASH_HOOK_ENDPOINT_FILE: endpointFile,
      });

      expect(url).toBe('http://127.0.0.1:6002/hook');
      expect(token).toBe('fresh-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the env when the endpoint file is missing or unreadable', async () => {
    const { url, token } = await resolveEndpoint({
      SWITCHDASH_HOOK_PORT: '5001',
      SWITCHDASH_HOOK_TOKEN: 'env-token',
      SWITCHDASH_PTY_ID: 'claude:s1',
      SWITCHDASH_HOOK_ENDPOINT_FILE: '/nonexistent/endpoint',
    });

    expect(url).toBe('http://127.0.0.1:5001/hook');
    expect(token).toBe('env-token');
  });

  it('falls back to the env when the endpoint file is empty (mid-write)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hook-ep-'));
    const endpointFile = path.join(dir, 'endpoint');
    await writeFile(endpointFile, '');

    try {
      const { url, token } = await resolveEndpoint({
        SWITCHDASH_HOOK_PORT: '5001',
        SWITCHDASH_HOOK_TOKEN: 'env-token',
        SWITCHDASH_PTY_ID: 'claude:s1',
        SWITCHDASH_HOOK_ENDPOINT_FILE: endpointFile,
      });

      expect(url).toBe('http://127.0.0.1:5001/hook');
      expect(token).toBe('env-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards the hook payload on stdin as the request body', async () => {
    // The port and the body travel through the same shell command, so a
    // restructuring that puts either behind a pipeline subshell silently drops
    // one or both — curl's `|| true` swallows the resulting failure.
    const payload = '{"tool_response":{"room_id":"r1","agent_id":"a1"}}';
    const { url, body } = await runHookCommand(
      makeStdinHookCommand('switch_room_connect', { platform: 'linux' }),
      {
        env: {
          SWITCHDASH_HOOK_PORT: '5001',
          SWITCHDASH_HOOK_TOKEN: 'env-token',
          SWITCHDASH_PTY_ID: 'codex:s1',
        },
        stdin: payload,
      }
    );

    expect(url).toBe('http://127.0.0.1:5001/hook');
    expect(body).toBe(payload);
  });

  it('stays recognisable to filterUserHooks so managed entries are replaced, not duplicated', () => {
    const command = makeStdinHookCommand('notification', { platform: 'linux' });

    expect(command).toContain(SWITCHDASH_MARKER);
    expect(filterUserHooks([{ command }, { command: 'user-own-hook' }])).toEqual([
      { command: 'user-own-hook' },
    ]);
  });
});
