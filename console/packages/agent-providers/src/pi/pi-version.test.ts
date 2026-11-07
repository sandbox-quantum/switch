import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProviderProcess from '../provider-process';

/** How execFile answers in place of the real one, when set (PV-1). */
const execFault = vi.hoisted(() => ({ answer: undefined as undefined | (() => Promise<never>) }));
vi.mock('../provider-process', async (importOriginal) => {
  const real = await importOriginal<typeof ProviderProcess>();
  return {
    ...real,
    execProvider: (...args: Parameters<typeof real.execProvider>) =>
      execFault.answer ? execFault.answer() : real.execProvider(...args),
  };
});
import { piArgs } from './pi-args';
import { piAgentDir } from './pi-paths';
import {
  assertPiVersion,
  parsePiVersion,
  PI_VERSION,
  PI_VERSION_ARGS,
  PiVersionError,
} from './pi-version';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-version-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `pi` that prints `stdout`, exits `code`, and records its argv and profile. */
function fakePi(stdout: string, code = 0): string {
  const path = join(dir, 'pi');
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/argv"\nprintf '%s' "$PI_CODING_AGENT_DIR" > "${dir}/agent-dir"\nprintf '${stdout}'\nexit ${code}\n`
  );
  chmodSync(path, 0o755);
  return path;
}

describe('assertPiVersion', () => {
  it('accepts exactly 1.4.0, asked offline and in Switch’s profile', async () => {
    const home = join(dir, 'home');
    await expect(assertPiVersion(fakePi('1.4.0\\n'), { env: { HOME: home } })).resolves.toBe(
      PI_VERSION
    );
    expect(readFileSync(join(dir, 'argv'), 'utf8').trim()).toBe('--version --offline');
    expect(readFileSync(join(dir, 'agent-dir'), 'utf8')).toBe(piAgentDir({ HOME: home }));
  });

  it.each(['0.73.0', '1.4.1', '1.4.0-beta.1'])(
    'refuses %s, naming the release to install',
    async (found) => {
      const error = await assertPiVersion(fakePi(`${found}\\n`)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PiVersionError);
      expect((error as PiVersionError).found).toBe(found);
      expect((error as Error).message).toContain('install @earendil-works/pi-coding-agent@1.4.0');
    }
  );

  it('refuses a Pi that prints no version or fails', async () => {
    for (const binary of [fakePi('pi: unknown option\\n'), fakePi('', 2), join(dir, 'missing')]) {
      const error = await assertPiVersion(binary).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PiVersionError);
      expect((error as PiVersionError).found).toBeNull();
      expect((error as Error).message).toContain('@earendil-works/pi-coding-agent@1.4.0');
    }
  });

  it('keeps why asking failed: the error, its code, and the code in its message', async () => {
    const unrunnable = join(dir, 'unrunnable');
    writeFileSync(unrunnable, '#!/bin/sh\necho 1.4.0\n');
    chmodSync(unrunnable, 0o644);
    for (const [binary, reason] of [
      [join(dir, 'missing'), 'ENOENT'],
      [unrunnable, 'EACCES'],
      [fakePi('', 2), 'exit 2'],
    ] as const) {
      const error = (await assertPiVersion(binary).catch(
        (caught: unknown) => caught
      )) as PiVersionError;
      expect(error, reason).toBeInstanceOf(PiVersionError);
      expect(error.found, reason).toBeNull();
      expect(error.reason, reason).toBe(reason);
      expect(error.message, reason).toContain(`did not print its version (${reason})`);
      expect(error.cause, reason).toBeInstanceOf(Error);
      if (reason !== 'exit 2') expect((error.cause as { code?: unknown }).code).toBe(reason);
    }
  });

  it('gives no reason when Pi ran and printed something other than a version', async () => {
    const error = (await assertPiVersion(fakePi('pi: unknown option\\n')).catch(
      (caught: unknown) => caught
    )) as PiVersionError;
    expect(error.reason).toBeNull();
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain('did not print its version:');
  });
});

describe('assertPiVersion, out of time', () => {
  it('refuses at once, with Pi killed, when Pi ignores SIGTERM and outlasts its time', async () => {
    const path = join(dir, 'pi');
    writeFileSync(
      path,
      `#!/bin/sh\ntrap '' TERM\necho $$ > "${dir}/pid"\nsleep 4\nprintf '${PI_VERSION}\\n'\n`
    );
    chmodSync(path, 0o755);
    const started = performance.now();
    const error = await assertPiVersion(path, { timeoutMs: 300 }).catch(
      (caught: unknown) => caught
    );
    const took = performance.now() - started;
    expect(error).toBeInstanceOf(PiVersionError);
    expect((error as PiVersionError).found).toBeNull();
    expect((error as PiVersionError).reason).toBe('OUT_OF_TIME');
    expect((error as Error).message).toContain('(OUT_OF_TIME)');
    // Its 300 ms, far from the 4 s Pi would go on for.
    expect(took).toBeLessThan(1_500);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // Killed, not left running: gone once Node has reaped it.
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 1_000; waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });
});

// PV-1: execFile's own `timeout` runs out at the moment `execWithin`'s timer does, and kills Pi
// with SIGKILL; on a busy machine its failure may be seen before that timer
// (`RUN/st5r8_codex_recheck_brief.md:27`). Each answer here is the error execFile gives then.
describe('assertPiVersion, out of time as execFile says it (PV-1)', () => {
  afterEach(() => {
    execFault.answer = undefined;
  });

  const failing = (fields: Record<string, unknown>) => () =>
    Promise.reject(Object.assign(new Error('Command failed: pi --version --offline'), fields));

  it.each([
    [
      'killed for its time (code null)',
      { killed: true, signal: 'SIGKILL', code: null },
      'OUT_OF_TIME',
    ],
    ['killed for its time (no code)', { killed: true, signal: 'SIGKILL' }, 'OUT_OF_TIME'],
    ['killed by someone else', { killed: false, signal: 'SIGKILL', code: null }, 'SIGKILL'],
    ['ended by another signal', { killed: false, signal: 'SIGTERM', code: null }, 'SIGTERM'],
    [
      'killed for printing too much',
      { killed: true, signal: 'SIGKILL', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    ],
  ])('says why, %s', async (_, fields, reason) => {
    execFault.answer = failing(fields);
    const error = (await assertPiVersion('/fake/pi', { timeoutMs: 60_000 }).catch(
      (caught: unknown) => caught
    )) as PiVersionError;
    expect(error).toBeInstanceOf(PiVersionError);
    expect(error.found).toBeNull();
    expect(error.reason).toBe(reason);
    expect(error.message).toContain(`(${reason})`);
  });
});

describe('parsePiVersion', () => {
  it('reads the first line only, and only a version', () => {
    expect(parsePiVersion('1.4.0\n')).toBe('1.4.0');
    expect(parsePiVersion('  1.4.0  \nwarning\n')).toBe('1.4.0');
    expect(parsePiVersion('pi 1.4.0')).toBeNull();
    expect(parsePiVersion('')).toBeNull();
  });
});

describe('PI_VERSION_ARGS', () => {
  it('comes from pi-args.ts, as every argument of a Pi Switch starts', () => {
    expect(PI_VERSION_ARGS).toEqual(piArgs({ kind: 'version' }));
    expect(PI_VERSION_ARGS).toContain('--offline');
  });
});
