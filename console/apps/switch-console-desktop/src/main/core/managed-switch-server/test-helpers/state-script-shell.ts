import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * An environment for running the state volume's scripts in this machine's
 * `sh`, against a directory standing in for the volume.
 *
 * The scripts take `flock` on the state mutex, which the helper image has and
 * macOS does not. Where there is none, a stand-in that takes nothing is put
 * first on the PATH: these tests are about what the scripts write, one at a
 * time. Whether the mutex holds is tested against a real volume, in
 * stack-lock.docker.test.ts.
 */
export function stateScriptEnv(): NodeJS.ProcessEnv {
  try {
    execFileSync('sh', ['-c', 'command -v flock'], { stdio: 'pipe' });
    return process.env;
  } catch {
    const bin = mkdtempSync(join(tmpdir(), 'no-flock-'));
    writeFileSync(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'flock'), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  }
}
