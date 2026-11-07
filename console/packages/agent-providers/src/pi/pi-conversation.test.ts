import { spawn, spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PI_BRIDGE_CONFIG_ENV } from './bridge';
import { validatePiSessionFile } from './pi-adapter';
import { PI_BASH_MARKER_ENV, piProcSource } from './pi-bash';
import {
  piConversationStore as storeFunction,
  piRecoverSource,
  type PiConversationOptions,
  type PiConversationStore,
} from './pi-conversation';

/**
 * R7-C: the store as the adapter and `pi-recover.mjs` make it, with the rule of where processes
 * are read (`piProcSource` of `./pi-bash.ts`). `storeFunction` is the self-contained function.
 */
const piConversationStore = (options: PiConversationOptions = {}) =>
  storeFunction({ procSource: piProcSource, ...options });

/**
 * The conversation store of `./pi-conversation.ts` (stage 5, round 1: R1-D, R1-E; SC26): the lock,
 * the mapping of a recovered conversation, and the recovery procedure, in this process and, for
 * what only another process can show (two takers at once, a kill in the middle), in plain `node`
 * processes running the very function the adapter writes into `pi-recover.mjs`.
 */

const ID = '0199a5c0-0000-7000-8000-00000000c0de';
let home: string;
let dir: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-conversation-'));
  dir = join(home, 'sessions');
  cwd = join(home, 'project');
  mkdirSync(dir);
  mkdirSync(cwd);
});

/** Process groups a test started (R2-B: what a Switch that is gone left running). */
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(home, { recursive: true, force: true });
});

const entry = (id: string, parentId: string | null, text = 'x') => ({
  type: 'message',
  id,
  parentId,
  message: { role: 'user', content: text },
});
/** A transcript with a branch: b and c are both children of a (Pi's `/tree`, a retried message). */
function branched(): string {
  return `${[
    { type: 'session', version: 3, id: ID, timestamp: 't', cwd },
    entry('a', null),
    entry('b', 'a'),
    entry('c', 'a', 'other branch'),
    entry('d', 'c'),
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')}\n`;
}
const CUT = '{"type":"message","id":"e","parentId":"d","mess';
function write(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
const ORIGINAL = `2026-11-03T10-00-00-000Z_${ID}.jsonl`;
const listing = () => readdirSync(dir).sort();
const mapped = () =>
  JSON.parse(readFileSync(join(dir, `${ID}.map.json`), 'utf8')) as { v: number; file: string };

/** The store's function as `pi-recover.mjs` holds it, in a plain `node -e` with `prelude` before it runs. */
function nodeWith(body: string, args: string[]) {
  const source = [
    `const piProcSource = (${piProcSource.toString()});`,
    `const storeFunction = (${storeFunction.toString()});`,
    'const piConversationStore = (options = {}) => storeFunction({ procSource: piProcSource, ...options });',
    'const fs = process.getBuiltinModule("node:fs");',
    body,
  ].join('\n');
  return spawn(process.execPath, ['-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}
async function finished(child: ReturnType<typeof spawn>) {
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.on('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
  );
  return { code, signal, out, err };
}
async function until(check: () => boolean, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the conversation lock (ER-07 exclusivity, R1-D)', () => {
  it('is held by one taker at a time, this process included, and released for the next', () => {
    const store = piConversationStore();
    const first = store.lock(dir, ID);
    expect('release' in first).toBe(true);
    const second = store.lock(dir, ID);
    expect(second).toEqual({ busy: expect.stringMatching(/held by process \d+/) });
    if ('release' in first) first.release();
    const third = store.lock(dir, ID);
    expect('release' in third).toBe(true);
    // The earlier entries are no one's: only the current one is left.
    expect(readdirSync(join(dir, `${ID}.lock`))).toEqual(['2.owner']);
  });

  it('takes over a lock whose holder is gone, never one whose start time is unknown or unreadable', () => {
    const store = piConversationStore();
    const lock = join(dir, `${ID}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, '3.owner'), JSON.stringify({ v: 1, pid: process.pid, start: null }));
    expect(store.lock(dir, ID)).toEqual({ busy: expect.any(String) });
    writeFileSync(join(lock, '3.owner'), 'not json');
    expect(store.lock(dir, ID)).toEqual({ busy: expect.any(String) });
    writeFileSync(join(lock, '3.owner'), JSON.stringify({ v: 1, pid: process.pid, start: 'x' }));
    expect('release' in store.lock(dir, ID)).toBe(true);
    expect(readdirSync(lock)).toEqual(['4.owner']);
  });

  it('a taker that read the old holder before another took it over does not take it again', () => {
    // B reads the free lock, then, before B creates its entry, A takes the lock over (the
    // interleaving of Codex S5-04, made exact with a file system that runs A at that moment).
    const lock = join(dir, `${ID}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, '1.owner'), JSON.stringify({ v: 1, pid: process.pid, start: 'gone' }));
    const a = piConversationStore();
    let heldByA: ReturnType<PiConversationStore['lock']> | null = null;
    const fs = new Proxy(realFs, {
      get(target, key, receiver) {
        if (key === 'writeFileSync')
          return (file: realFs.PathOrFileDescriptor, ...rest: unknown[]) => {
            if (heldByA === null && typeof file === 'string' && file.endsWith('.tmp'))
              heldByA = a.lock(dir, ID);
            return (target.writeFileSync as (...args: unknown[]) => void)(file, ...rest);
          };
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as typeof realFs;
    const b = piConversationStore({ fs });
    const heldByB = b.lock(dir, ID);
    const takenByA: unknown = heldByA;
    // R4-A: a lock taken names the identity it was taken with.
    expect(takenByA).toEqual({ release: expect.any(Function), owner: a.ownIdentity() });
    expect(heldByB).toEqual({ busy: expect.stringMatching(/held by process/) });
  });

  it('of six processes taking over a lock its holder left at the same moment, one holds it', async () => {
    const lock = join(dir, `${ID}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, '1.owner'), JSON.stringify({ v: 1, pid: 1, start: 'gone' }));
    const at = Date.now() + 700;
    const children = Array.from({ length: 6 }, () =>
      nodeWith(
        [
          'const [dir, id, at] = process.argv.slice(1);',
          'while (Date.now() < Number(at)) {}',
          'const held = piConversationStore().lock(dir, id);',
          'process.stdout.write("release" in held ? "held" : "busy");',
          'setTimeout(() => {}, 600);',
        ].join('\n'),
        [dir, ID, String(at)]
      )
    );
    const results = await Promise.all(children.map(finished));
    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(results.filter((result) => result.out === 'held')).toHaveLength(1);
    expect(results.filter((result) => result.out === 'busy')).toHaveLength(5);
  });

  it('tells processes apart with ps where there is no procfs (R1-I)', () => {
    const store = piConversationStore({ procRoot: join(home, 'no-proc') });
    const own = store.processStart(process.pid);
    expect(own?.start).toMatch(/^ps:\S/);
    expect(store.stillRuns(process.pid, own?.start)).toBe(true);
    expect(store.stillRuns(process.pid, 'ps:Thu Jan  1 00:00:00 1970')).toBe(false);
    // Read one way and recorded the other: cannot be told, so taken to run.
    expect(store.stillRuns(process.pid, '12345')).toBe(true);
    const gone = spawnSync('/bin/true').pid as number;
    expect(store.processStart(gone)).toBeNull();
    const lock = join(dir, `${ID}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, '1.owner'), JSON.stringify({ v: 1, pid: gone, start: 'ps:x' }));
    expect('release' in store.lock(dir, ID)).toBe(true);
    expect(store.lock(dir, ID)).toEqual({ busy: expect.any(String) });
    expect(JSON.parse(readFileSync(join(lock, '2.owner'), 'utf8'))).toMatchObject({
      pid: process.pid,
      start: own?.start,
    });
  });
});

describe('which file is the conversation', () => {
  it('is the one transcript of it, or the one its record names (the original then never)', () => {
    const store = piConversationStore();
    expect(store.transcript(dir, ID)).toEqual({ none: true });
    const original = write(ORIGINAL, branched());
    expect(store.transcript(dir, ID)).toEqual({ file: original, mapped: false });
    const other = write(`2026-11-04T10-00-00-000Z_${ID}.jsonl`, branched());
    expect(store.transcript(dir, ID)).toEqual({ problem: expect.stringMatching(/holds 2/) });
    writeFileSync(
      join(dir, `${ID}.map.json`),
      JSON.stringify({ v: 1, file: `2026-11-04T10-00-00-000Z_${ID}.jsonl` })
    );
    expect(store.transcript(dir, ID)).toEqual({ file: other, mapped: true });
    for (const record of ['{', '{"v":1,"file":"../x.jsonl"}', '{"v":2,"file":"' + ORIGINAL + '"}'])
      expect(
        (writeFileSync(join(dir, `${ID}.map.json`), record), store.transcript(dir, ID))
      ).toEqual({ problem: expect.stringMatching(/is not one Switch wrote/) });
  });

  it('accepts branches as Pi writes them', () => {
    expect(piConversationStore().checkText(branched(), { id: ID, cwd: [cwd] })).toEqual({
      ok: true,
    });
  });
});

describe('recover a conversation (SC26, Q2 A′)', () => {
  it('shows what it would do and writes nothing without the confirmation', () => {
    write(ORIGINAL, branched() + CUT);
    const before = listing();
    const preview = piConversationStore().recover(dir, ID);
    expect(preview).toMatchObject({
      status: 'preview',
      from: join(dir, ORIGINAL),
      keptEntries: 4,
      branches: 1,
      removedBytes: Buffer.byteLength(CUT),
      removedStart: CUT,
      digest: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(listing()).toEqual([...before, `${ID}.lock`].sort());
    // A confirmation that is not this preview's does nothing either.
    expect(piConversationStore().recover(dir, ID, '0000000000000000')).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/not the one the preview showed/),
    });
    expect(listing()).toEqual([...before, `${ID}.lock`].sort());
  });

  it('writes a new transcript of the same conversation without only the cut-off tail, then switches to it; the original is kept and never resumed', async () => {
    const text = branched() + CUT;
    const original = write(ORIGINAL, text);
    const store = piConversationStore({ now: () => new Date('2026-11-03T12:00:00.000Z') });
    const preview = store.recover(dir, ID);
    if (preview.status !== 'preview') throw new Error('no preview');
    const done = store.recover(dir, ID, preview.digest);
    expect(done).toMatchObject({ status: 'recovered', to: preview.to });
    expect(preview.to).toBe(join(dir, `2026-11-03T12-00-00-000Z_${ID}.jsonl`));
    // Every entry and both branches, byte for byte; nothing but the tail is gone.
    expect(readFileSync(preview.to, 'utf8')).toBe(branched());
    expect(readFileSync(original, 'utf8')).toBe(text);
    expect(mapped()).toMatchObject({ v: 1, file: `2026-11-03T12-00-00-000Z_${ID}.jsonl` });
    expect(store.transcript(dir, ID)).toEqual({ file: preview.to, mapped: true });
    expect(await validatePiSessionFile(preview.to, { id: ID, cwd: [cwd] })).toEqual({ ok: true });
    // Done: the next run finds nothing to recover, and the lock is free again.
    expect(store.recover(dir, ID)).toEqual({ status: 'whole', file: preview.to });
    expect('release' in store.lock(dir, ID)).toBe(true);
  });

  it.each([
    [
      'a broken line in the middle',
      () => `${branched().replace('"id":"b"', '"id":"b')}${CUT}`,
      /not JSON/,
    ],
    [
      'a parent missing in the middle',
      () => `${branched().replace('"parentId":"c"', '"parentId":"zz"')}${CUT}`,
      /parent is not in the file/,
    ],
    [
      'a whole transcript that is wrong',
      () => branched().replace('"version":3', '"version":2'),
      /format version 2/,
    ],
    ['nothing whole to keep', () => CUT, /no whole line/],
  ])('refuses %s, and writes nothing', (_name, text, reason) => {
    write(ORIGINAL, text());
    const before = listing();
    const result = piConversationStore().recover(dir, ID);
    expect(result).toEqual({ status: 'refused', reason: expect.stringMatching(reason) });
    expect(listing()).toEqual([...before, `${ID}.lock`].sort());
  });

  it('refuses while the conversation is open (its lock), and while a stop left its processes unconfirmed', () => {
    write(ORIGINAL, branched() + CUT);
    const store = piConversationStore();
    const held = store.lock(dir, ID);
    expect(store.recover(dir, ID)).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/open in Switch or being recovered/),
    });
    if ('release' in held) held.release();
    store.addCleanup(dir, ID, [
      { runDir: '/r', registry: '/r/p.jsonl', bridgeConfig: '/r/c.json' },
    ]);
    expect(store.recover(dir, ID)).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/Pi may still write the transcript/),
    });
    store.clearCleanup(dir, ID);
    expect(store.recover(dir, ID)).toMatchObject({ status: 'preview' });
  });

  it('R5-B: a launch the record says ended does not refuse; the record keeps the host’s identity, settles step by step, and is never of another shape', () => {
    write(ORIGINAL, branched() + CUT);
    const store = piConversationStore();
    const owner = { pid: 4242, start: '1234' };
    store.addCleanup(dir, ID, [
      { runDir: '/r1', registry: '/r1/p.jsonl', bridgeConfig: '/r1/c.json', owner },
      { runDir: '/r2', registry: '/r2/p.jsonl', bridgeConfig: '/r2/c.json', owner },
    ]);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [
        { runDir: '/r1', registry: '/r1/p.jsonl', bridgeConfig: '/r1/c.json', owner },
        { runDir: '/r2', registry: '/r2/p.jsonl', bridgeConfig: '/r2/c.json', owner },
      ],
    });
    expect(store.settleCleanup(dir, ID, '/r1', 'ended')).toBe(true);
    expect(store.recover(dir, ID)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/Pi may still write the transcript/),
    });
    expect(store.settleCleanup(dir, ID, '/r2', 'ended')).toBe(true);
    // Every launch ended: only their directories and entries are left, which write nothing.
    expect(store.recover(dir, ID)).toMatchObject({ status: 'preview' });
    expect(store.settleCleanup(dir, ID, '/r1', 'drop')).toBe(true);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [
        { runDir: '/r2', registry: '/r2/p.jsonl', bridgeConfig: '/r2/c.json', owner, ended: true },
      ],
    });
    expect(store.settleCleanup(dir, ID, '/r9', 'ended')).toBe(false);
    expect(store.settleCleanup(dir, ID, '/r2', 'drop')).toBe(true);
    expect(existsSync(join(dir, `${ID}.cleanup.json`))).toBe(false);
    for (const launch of [
      { runDir: '/r', registry: '/r/p', bridgeConfig: '/r/c', owner: { pid: 1, start: null } },
      { runDir: '/r', registry: '/r/p', bridgeConfig: '/r/c', ended: false },
    ]) {
      writeFileSync(join(dir, `${ID}.cleanup.json`), JSON.stringify({ v: 1, launches: [launch] }));
      expect(store.readCleanup(dir, ID)).toEqual({
        problem: expect.stringMatching(/not a record/),
      });
      expect(() => store.settleCleanup(dir, ID, '/r', 'drop')).toThrow(/not a record/);
    }
  });

  it('makes each step durable before the next: the file, then its directory', () => {
    write(ORIGINAL, branched() + CUT);
    const calls: string[] = [];
    const fds = new Map<number, string>();
    const fs = new Proxy(realFs, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key === 'openSync')
          return (file: string, ...rest: unknown[]) => {
            const fd = (value as (...args: unknown[]) => number)(file, ...rest);
            fds.set(fd, file);
            return fd;
          };
        if (key === 'fsyncSync')
          return (fd: number) => {
            const file = fds.get(fd) ?? '?';
            calls.push(`fsync ${file === dir ? 'dir' : file.endsWith('.tmp') ? 'tmp' : file}`);
            return (value as (fd: number) => void)(fd);
          };
        if (key === 'renameSync')
          return (from: string, to: string) => {
            calls.push(`rename ${to.slice(dir.length + 1)}`);
            return (value as (a: string, b: string) => void)(from, to);
          };
        return value;
      },
    }) as typeof realFs;
    const store = piConversationStore({ fs, now: () => new Date('2026-11-03T12:00:00.000Z') });
    const preview = store.recover(dir, ID);
    if (preview.status !== 'preview') throw new Error('no preview');
    calls.length = 0;
    store.recover(dir, ID, preview.digest);
    expect(calls).toEqual([
      'fsync tmp',
      `rename ${ID}.map.json`,
      'fsync dir',
      'fsync tmp',
      `rename 2026-11-03T12-00-00-000Z_${ID}.jsonl`,
      'fsync dir',
      'fsync tmp',
      `rename ${ID}.map.json`,
      'fsync dir',
      // R6-C: the lock is let go last, and durably (its release is tried again when this fails).
      'fsync tmp',
      `rename ${ID}.lock/2.released`,
      `fsync ${join(dir, `${ID}.lock`)}`,
    ]);
  });

  it('killed (SIGKILL) between the new transcript and the switch: the record names the old file, a resume refuses, and the procedure runs again', async () => {
    const text = branched() + CUT;
    const original = write(ORIGINAL, text);
    const preview = piConversationStore().recover(dir, ID);
    if (preview.status !== 'preview') throw new Error('no preview');
    // In its own process: SIGKILL at the second rename of the record (the switch), after the new
    // transcript was written and made durable.
    const child = nodeWith(
      [
        'const [dir, id, digest] = process.argv.slice(1);',
        'let renames = 0;',
        'const killing = new Proxy(fs, { get(target, key) {',
        '  if (key === "renameSync") return (from, to) => {',
        '    if (to.endsWith(".map.json") && ++renames === 2) process.kill(process.pid, "SIGKILL");',
        '    return target.renameSync(from, to);',
        '  };',
        '  return target[key];',
        '} });',
        'piConversationStore({ fs: killing }).recover(dir, id, digest);',
      ].join('\n'),
      [dir, ID, preview.digest]
    );
    const result = await finished(child);
    expect(result.signal).toBe('SIGKILL');
    const leftover = listing().filter((name) => name.endsWith('.jsonl') && name !== ORIGINAL);
    expect(leftover).toHaveLength(1);
    expect(readFileSync(join(dir, leftover[0] as string), 'utf8')).toBe(branched());
    expect(mapped().file).toBe(ORIGINAL);
    const store = piConversationStore();
    expect(store.transcript(dir, ID)).toEqual({ file: original, mapped: true });
    expect(await validatePiSessionFile(original, { id: ID, cwd: [cwd] })).toMatchObject({
      ok: false,
      cutOff: true,
    });
    // Again: the dead process's lock is taken over, and it completes.
    const again = store.recover(dir, ID);
    if (again.status !== 'preview') throw new Error(`no preview: ${JSON.stringify(again)}`);
    expect(again.digest).toBe(preview.digest);
    const done = store.recover(dir, ID, again.digest);
    if (done.status !== 'recovered') throw new Error(`not recovered: ${JSON.stringify(done)}`);
    expect(store.transcript(dir, ID)).toEqual({ file: done.to, mapped: true });
    expect(readFileSync(done.to, 'utf8')).toBe(branched());
    expect(readFileSync(original, 'utf8')).toBe(text);
  });

  it('holds the conversation while it runs: a second procedure and a session are refused meanwhile', async () => {
    write(ORIGINAL, branched() + CUT);
    const preview = piConversationStore().recover(dir, ID);
    if (preview.status !== 'preview') throw new Error('no preview');
    const go = join(home, 'go');
    const waiting = join(home, 'waiting');
    const child = nodeWith(
      [
        'const [dir, id, digest, go, waiting] = process.argv.slice(1);',
        'const pausing = new Proxy(fs, { get(target, key) {',
        '  if (key === "renameSync") return (from, to) => {',
        '    if (to.endsWith(".jsonl")) {',
        '      fs.writeFileSync(waiting, "");',
        '      while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
        '    }',
        '    return target.renameSync(from, to);',
        '  };',
        '  return target[key];',
        '} });',
        'process.stdout.write(piConversationStore({ fs: pausing }).recover(dir, id, digest).status);',
      ].join('\n'),
      [dir, ID, preview.digest, go, waiting]
    );
    const done = finished(child);
    await until(() => existsSync(waiting), 'the procedure under way');
    const store = piConversationStore();
    expect(store.lock(dir, ID)).toEqual({ busy: expect.stringMatching(/held by process/) });
    expect(store.recover(dir, ID)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/being recovered/),
    });
    writeFileSync(go, '');
    expect((await done).out).toBe('recovered');
    expect('release' in store.lock(dir, ID)).toBe(true);
  });

  it('runs as pi-recover.mjs: the preview prints the exact command, which recovers', async () => {
    write(ORIGINAL, branched() + CUT);
    const script = join(home, 'pi-recover.mjs');
    writeFileSync(script, piRecoverSource());
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const usage = run(dir);
    expect(usage.status).toBe(2);
    const shown = run(dir, ID);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toMatch(/removed: +the cut-off last line/);
    const command = /^ {2}(node .* --confirm [0-9a-f]{16})$/m.exec(shown.stdout)?.[1];
    expect(command).toBeDefined();
    expect(command).toContain(`'${script}' '${dir}' '${ID}'`);
    const done = spawnSync('/bin/sh', ['-c', command as string], {
      encoding: 'utf8',
      env: { PATH: `${join(process.execPath, '..')}:/usr/bin:/bin` },
    });
    expect(done.status).toBe(0);
    expect(done.stdout).toMatch(/^Recovered: /m);
    expect(run(dir, ID).stdout).toMatch(/needs no recovery/);
    const held = piConversationStore().lock(dir, ID);
    const refused = run(dir, ID);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/open in Switch/);
    if ('release' in held) held.release();
  });
});

describe('recover a conversation a Switch that is gone left launches of (R2-B)', () => {
  const launch = (name = 'launch-1') => join(home, 'run', name);
  /** What `pi-adapter.ts` writes into a launch's directory before its Pi starts. */
  function leave(owner: Record<string, unknown> | null, name = 'launch-1'): string {
    const dir = launch(name);
    mkdirSync(dir, { recursive: true });
    if (owner) writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
    return dir;
  }
  /**
   * A Switch that is gone: this pid, with a start time it never had, one tick after its own (as a
   * real one's, earlier than what it started: R3-A leaves out unreadable processes older than it).
   */
  const ownStart = piConversationStore().ownIdentity().start ?? '0';
  const deadHost = {
    v: 1,
    pid: process.pid,
    start: String(BigInt(ownStart) + 1n),
    piSessionId: ID,
  };
  /** A live process (its own group) with `env` only. */
  function live(env: Record<string, string>, script = 'exec sleep 60'): number {
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', ...env },
    });
    child.unref();
    const pid = child.pid as number;
    started.push(pid);
    return pid;
  }
  const gone = (pid: number) => {
    const found = piConversationStore().processStart(pid);
    return found === null || found.zombie;
  };
  async function kill(pid: number) {
    process.kill(-pid, 'SIGKILL');
    await until(() => gone(pid), `process ${pid} gone`);
  }
  /**
   * R4-A: a procfs that shows only `pids` (links to their entries in `/proc`), and, with
   * `unreadable`, one process whose environment cannot be read (`EISDIR`): what the scan sees is
   * exactly that, whatever else runs on the machine.
   */
  function procOf(pids: number[], options: { unreadable?: boolean } = {}): string {
    const root = mkdtempSync(join(home, 'proc-'));
    for (const pid of pids) symlinkSync(`/proc/${pid}`, join(root, String(pid)));
    if (options.unreadable) mkdirSync(join(root, '999999', 'environ'), { recursive: true });
    return root;
  }

  it('names the environment the bridge and the bash tool set (the procedure has no imports)', () => {
    const source = storeFunction.toString();
    expect(source).toContain(`\`${PI_BRIDGE_CONFIG_ENV}=\${`);
    expect(source).toContain(`\`${PI_BASH_MARKER_ENV}=\${`);
  });

  it('refuses while the Pi of a launch a dead Switch left still runs, and recovers once it is gone', async () => {
    write(ORIGINAL, branched() + CUT);
    const run = leave(deadHost);
    const pi = live({ [PI_BRIDGE_CONFIG_ENV]: join(run, 'config.json') });
    await until(() => !gone(pi), 'stand-in Pi');
    const store = piConversationStore();
    // The lock the dead Switch held is free: only the launch tells that its Pi may still write.
    const lock = store.lock(dir, ID);
    expect('release' in lock).toBe(true);
    if ('release' in lock) lock.release();
    const before = listing();
    const refused = store.recover(dir, ID);
    expect(refused).toEqual({
      status: 'refused',
      reason: expect.stringMatching(
        new RegExp(`Pi of launch .*launch-1 still runs \\(process ${pi} \\(sleep\\)\\)`)
      ),
    });
    expect(listing()).toEqual(before);
    await kill(pi);
    const preview = store.recover(dir, ID);
    if (preview.status !== 'preview') throw new Error(`no preview: ${JSON.stringify(preview)}`);
    expect(store.recover(dir, ID, preview.digest)).toMatchObject({ status: 'recovered' });
  });

  it('refuses while a group or an intended shell of such a launch still runs', async () => {
    write(ORIGINAL, branched() + CUT);
    const run = leave(deadHost);
    // U-8/U-9 (FAP-10, joint round 4): markers of this run only. With procfs an adapter kills every
    // process carrying a marker its registry names; one in another test run at once (`i-1:c1` is a
    // marker of the adapter's tests too) would kill these decoys.
    const [c1, c2] = [`i-1:c1@${home}`, `i-1:c2@${home}`];
    const shell = live({ [PI_BASH_MARKER_ENV]: c1 }, 'env -i /bin/sleep 60 & wait');
    const intended = live({ [PI_BASH_MARKER_ENV]: c2 });
    await until(() => !gone(shell) && !gone(intended), 'shells');
    const base = { v: 1, instance: 'i-1', run: 1 };
    writeFileSync(
      join(run, 'processes.jsonl'),
      [
        { ...base, toolCallId: 'c1', marker: c1, event: 'intent' },
        { ...base, toolCallId: 'c1', marker: c1, event: 'spawn', pid: shell, pgid: shell },
        { ...base, toolCallId: 'c2', marker: c2, event: 'intent' },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('') + '{"v":1,"event":"sp'
    );
    const store = piConversationStore();
    const reason = () => {
      const result = store.recover(dir, ID);
      return result.status === 'refused' ? result.reason : result.status;
    };
    expect(reason()).toMatch(new RegExp(`process group\\(s\\) ${shell} of launch .* still run`));
    expect(reason()).toMatch(
      new RegExp(`command\\(s\\) of launch .* still run \\(process .*${intended}`)
    );
    await kill(shell);
    expect(reason()).not.toMatch(/process group/);
    expect(reason()).toMatch(/command\(s\) of launch/);
    await kill(intended);
    expect(reason()).toBe('preview');
  });

  it('refuses a launch whose Switch still runs or cannot be told gone, and anything it cannot see', () => {
    write(ORIGINAL, branched() + CUT);
    const sessions = join(home, 'sessions');
    const store = piConversationStore();
    const own = store.ownIdentity();
    leave({ ...deadHost, start: own.start });
    expect(store.recover(sessions, ID)).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/belongs to Switch process \d+, which still runs/),
    });
    // R4-A: an owner without a start time cannot be told gone: the launch is over only once
    // nothing of it is seen to live, and a process that cannot be read counts.
    leave({ ...deadHost, start: null });
    expect(
      piConversationStore({ procRoot: procOf([], { unreadable: true }) }).recover(sessions, ID)
    ).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/whether the Pi of launch .* runs cannot be seen/),
    });
    // Without procfs (`ps`): the Switch is told gone, but no environment can be read, so
    // whether its Pi runs cannot be seen.
    leave({ ...deadHost, start: 'ps:Thu Jan  1 00:00:00 1970' });
    const noProc = piConversationStore({ procRoot: join(home, 'no-proc') });
    expect(noProc.recover(sessions, ID)).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/whether the Pi of launch .* runs cannot be seen/),
    });
    leave(deadHost);
    expect(store.recover(sessions, ID)).toMatchObject({ status: 'preview' });
  });

  it('leaves alone the launches of other conversations, and ownerless ones nothing of which runs', async () => {
    write(ORIGINAL, branched() + CUT);
    const sessions = join(home, 'sessions');
    const other = leave({ ...deadHost, piSessionId: 'another' }, 'launch-other');
    const otherPi = live({ [PI_BRIDGE_CONFIG_ENV]: join(other, 'config.json') });
    await until(() => !gone(otherPi), 'other Pi');
    const store = piConversationStore();
    expect(store.recover(sessions, ID)).toMatchObject({ status: 'preview' });
    leave(null, 'launch-ownerless');
    // R3-A: an ownerless launch has no Switch start to tell older processes by. Nothing of it
    // runs where every process is seen (a procfs of this process only, which carries nothing of
    // the launch)…
    expect(
      piConversationStore({ procRoot: procOf([process.pid]) }).recover(sessions, ID)
    ).toMatchObject({
      status: 'preview',
    });
    // R7-C (Codex A12): an empty directory someone passed is no procfs, so it shows nothing: the
    // launch cannot be told over there.
    const emptyProc = join(home, 'proc-empty');
    mkdirSync(emptyProc);
    expect(piConversationStore({ procRoot: emptyProc }).recover(sessions, ID)).toMatchObject({
      status: 'refused',
    });
    // …and a process of this user that cannot be read leaves it unresolved.
    const unseen = live({});
    await until(() => !gone(unseen), 'unseen process');
    expect(
      reasonOf(faulty((file) => (file === `/proc/${unseen}/environ` ? 'EACCES' : null)))
    ).toMatch(/launch-ownerless has no owner Switch can read and its processes cannot be seen/);
    await kill(unseen);
    // An ownerless launch whose Pi runs cannot be told from one of this conversation.
    const ownerless = live({
      [PI_BRIDGE_CONFIG_ENV]: join(launch('launch-ownerless'), 'config.json'),
    });
    await until(() => !gone(ownerless), 'ownerless Pi');
    expect(store.recover(sessions, ID)).toEqual({
      status: 'refused',
      reason: expect.stringMatching(/has no owner Switch can read and its Pi still runs/),
    });
  });

  /** A store whose procfs answers `fault(file)` (an error code) for a file, the truth otherwise. */
  function faulty(fault: (file: string) => string | null, options: { uid?: number } = {}) {
    const fs = new Proxy(realFs, {
      get(target, key, receiver) {
        if (key === 'readFileSync')
          return (file: realFs.PathOrFileDescriptor, ...rest: unknown[]) => {
            const failure = typeof file === 'string' ? fault(file) : null;
            if (failure)
              throw Object.assign(new Error(`${failure}: ${file} (test)`), { code: failure });
            return (target.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
          };
        return Reflect.get(target, key, receiver) as unknown;
      },
    }) as typeof realFs;
    return piConversationStore({ fs, ...options });
  }
  const reasonOf = (store: PiConversationStore) => {
    const result = store.recover(join(home, 'sessions'), ID);
    return result.status === 'refused' ? result.reason : result.status;
  };

  it('R3-A: refuses while the Pi of such a launch cannot be read (EACCES, this user’s process, EIO on stat)', async () => {
    write(ORIGINAL, branched() + CUT);
    const run = leave(deadHost);
    const pi = live({ [PI_BRIDGE_CONFIG_ENV]: join(run, 'config.json') });
    await until(() => !gone(pi), 'stand-in Pi');
    const environ = faulty((file) => (file === `/proc/${pi}/environ` ? 'EACCES' : null));
    expect(reasonOf(environ)).toMatch(/whether the Pi of launch .* runs cannot be seen/);
    const stat = faulty((file) => (file === `/proc/${pi}/stat` ? 'EIO' : null));
    expect(reasonOf(stat)).toMatch(/whether the Pi of launch .* runs cannot be seen/);
    await kill(pi);
    expect(reasonOf(environ)).toBe('preview');
  });

  it('R3-A: leaves out a process procfs shows to be another user’s, and one older than the Switch that made the launch', async () => {
    write(ORIGINAL, branched() + CUT);
    const run = leave(deadHost);
    const pi = live({ [PI_BRIDGE_CONFIG_ENV]: join(run, 'config.json') });
    await until(() => !gone(pi), 'stand-in Pi');
    const uid = (process.getuid?.() ?? 0) + 1;
    const foreign = faulty((file) => (file === `/proc/${pi}/environ` ? 'EACCES' : null), { uid });
    expect(reasonOf(foreign)).toBe('preview');
    // The parent of this process started before the Switch that is gone (this one's start + 1).
    const older = faulty((file) => (file === `/proc/${process.ppid}/environ` ? 'EACCES' : null));
    expect(reasonOf(older)).toMatch(/Pi of launch .* still runs/);
    await kill(pi);
    expect(reasonOf(older)).toBe('preview');
    // A launch whose owner (gone) has no start time Switch can compare: nothing rules that parent
    // out.
    leave({ ...deadHost, start: 'gone' });
    expect(reasonOf(older)).toMatch(/whether the Pi of launch .* runs cannot be seen/);
  });

  /** A registry (`processes.jsonl`) with one shell spawned as group `pid`. */
  function registerShell(run: string, pid: number): void {
    const base = { v: 1, instance: 'i-1', run: 1, toolCallId: 'c1', marker: 'i-1:c1' };
    writeFileSync(
      join(run, 'processes.jsonl'),
      `${JSON.stringify({ ...base, event: 'intent' })}\n${JSON.stringify({ ...base, event: 'spawn', pid, pgid: pid })}\n`
    );
  }

  it('R4-A: a launch of this conversation whose owner has no start time is over only once nothing of it lives: its Pi, its groups', async () => {
    write(ORIGINAL, branched() + CUT);
    const sessions = join(home, 'sessions');
    const run = leave({ ...deadHost, start: null });
    const pi = live({ [PI_BRIDGE_CONFIG_ENV]: join(run, 'config.json') });
    const shell = live({}, 'env -i /bin/sleep 60 & wait');
    await until(() => !gone(pi) && !gone(shell), 'stand-ins');
    registerShell(run, shell);
    const store = piConversationStore({ procRoot: procOf([pi, shell]) });
    const reason = () => {
      const result = store.recover(sessions, ID);
      return result.status === 'refused' ? result.reason : result.status;
    };
    expect(reason()).toMatch(/the Pi of launch .* still runs/);
    expect(reason()).not.toMatch(/belongs to Switch process/);
    await kill(pi);
    expect(reason()).toMatch(new RegExp(`process group\\(s\\) ${shell} of launch .* still run`));
    await kill(shell);
    expect(reason()).toBe('preview');
    // A launch of another conversation with no start time is not this procedure's.
    leave({ ...deadHost, start: null, piSessionId: 'another' }, 'launch-other');
    const other = live({ [PI_BRIDGE_CONFIG_ENV]: join(launch('launch-other'), 'config.json') });
    await until(() => !gone(other), 'other Pi');
    expect(piConversationStore({ procRoot: procOf([other]) }).recover(sessions, ID)).toMatchObject({
      status: 'preview',
    });
  });

  it('R4-A: a launch whose owner.json is damaged or cannot be read names no conversation: refused while its Pi or a group of it lives', async () => {
    write(ORIGINAL, branched() + CUT);
    const sessions = join(home, 'sessions');
    const run = leave(null, 'launch-damaged');
    writeFileSync(join(run, 'owner.json'), '{"v":1,"pid":');
    const shell = live({}, 'env -i /bin/sleep 60 & wait');
    await until(() => !gone(shell), 'shell');
    registerShell(run, shell);
    const store = piConversationStore({ procRoot: procOf([shell]) });
    const reason = () => {
      const result = store.recover(sessions, ID);
      return result.status === 'refused' ? result.reason : result.status;
    };
    // Only its group lives: its Pi is not seen, the group still refuses.
    expect(reason()).toMatch(
      /launch .*launch-damaged has an owner \(owner\.json\) that is damaged, so its conversation is unknown, and process group\(s\) \d+ of launch .* still run/
    );
    writeFileSync(join(run, 'owner.json'), JSON.stringify({ v: 1, pid: 'x' }));
    expect(reason()).toMatch(/that is not one Switch wrote, so its conversation is unknown/);
    writeFileSync(join(run, 'owner.json'), JSON.stringify(deadHost));
    chmodSync(join(run, 'owner.json'), 0o000);
    expect(reason()).toMatch(/that cannot be read \(EACCES\), so its conversation is unknown/);
    await kill(shell);
    expect(reason()).toBe('preview');
    // Without anything to see it by (an unreadable process), it stays refused.
    expect(
      piConversationStore({ procRoot: procOf([], { unreadable: true }) }).recover(sessions, ID)
    ).toMatchObject({ status: 'refused' });
  });
});

describe('round 6 (D-16 A′, D-15 part 2): no failure loses the release of a lock; without procfs nothing unseen is gone', () => {
  const lockDir = () => join(dir, `${ID}.lock`);
  const eio = (file: unknown) =>
    Object.assign(new Error(`EIO: ${String(file)} (test)`), { code: 'EIO' });
  /** `realFs` with `key` replaced by `make(real)`. */
  function with_(key: string, make: (real: (...args: unknown[]) => unknown) => unknown) {
    return new Proxy(realFs, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        return name === key ? make(value as (...args: unknown[]) => unknown) : value;
      },
    }) as typeof realFs;
  }
  /** The system's `ps`, showing only `pids`; `fail`: exits 3; `blank`: exits 0 and prints nothing. */
  function fakePs(pids: number[], how: 'see' | 'fail' | 'blank' | 'garbage' = 'see'): string {
    const at = mkdtempSync(join(home, 'ps-'));
    const allow = join(at, 'pids');
    writeFileSync(allow, pids.map((pid) => `${pid}\n`).join(''));
    const script = join(at, 'ps');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        ...(how === 'fail' ? ['exit 3'] : how === 'blank' ? ['exit 0'] : []),
        'prev=; pid=',
        'for a in "$@"; do [ "$prev" = "-p" ] && pid="$a"; prev="$a"; done',
        `if [ -n "$pid" ]; then grep -qx "$pid" '${allow}' || exit 1; exec ps "$@"; fi`,
        `ps "$@" | awk 'NR == FNR { ok[$1] = 1; next } ($1 in ok)' '${allow}' -`,
        // A line that is not a row, after the rows.
        ...(how === 'garbage' ? ['echo "half-row 12"'] : []),
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    return script;
  }

  it('D-16: a launch Switch is removing (renamed to .removed-<id>) does not hold up the recovery, even with an owner that still runs', () => {
    write(ORIGINAL, branched() + CUT);
    const removed = join(home, 'run', '.removed-0b1c');
    mkdirSync(removed, { recursive: true });
    writeFileSync(
      join(removed, 'owner.json'),
      JSON.stringify({
        v: 1,
        pid: process.pid,
        start: piConversationStore().ownIdentity().start,
        piSessionId: ID,
      })
    );
    expect(piConversationStore().recover(dir, ID)).toMatchObject({ status: 'preview' });
    // The same launch under its own name refuses (its Switch, this process, still runs).
    renameSync(removed, join(home, 'run', 'launch-live'));
    expect(piConversationStore().recover(dir, ID)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/belongs to Switch process \d+, which still runs/),
    });
  });

  it('D16-C1: a lock whose check after the link cannot be read is handed out as failed, with its release; once released, the next taker takes it', () => {
    let linked = false;
    const fs = new Proxy(realFs, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as (...args: unknown[]) => unknown;
        if (name === 'linkSync')
          return (...args: unknown[]) => {
            const done = value(...args);
            linked = true;
            return done;
          };
        if (name === 'readdirSync')
          return (...args: unknown[]) => {
            if (linked && String(args[0]) === lockDir()) {
              linked = false;
              throw eio(args[0]);
            }
            return value(...args);
          };
        return value;
      },
    }) as typeof realFs;
    const held = piConversationStore({ fs }).lock(dir, ID);
    expect(held).toEqual({
      failed: expect.stringMatching(/cannot list .* after taking it \(EIO\)/),
      release: expect.any(Function),
    });
    // Until it is let go, the entry is this process's: the lock is held.
    expect(piConversationStore().lock(dir, ID)).toEqual({
      busy: expect.stringMatching(/held by process/),
    });
    if (!('release' in held)) throw new Error('no release');
    held.release();
    expect('owner' in piConversationStore().lock(dir, ID)).toBe(true);
  });

  it('D16-C1: a link made and still answered with an error is this process’s too (its temporary file has two names)', () => {
    const fs = with_('linkSync', (real) => (...args: unknown[]) => {
      real(...args);
      throw eio(args[1]);
    });
    const held = piConversationStore({ fs }).lock(dir, ID);
    expect(held).toEqual({
      failed: expect.stringMatching(/answered EIO/),
      release: expect.any(Function),
    });
    expect(piConversationStore().lock(dir, ID)).toEqual({ busy: expect.any(String) });
    if (!('release' in held)) throw new Error('no release');
    held.release();
    expect('owner' in piConversationStore().lock(dir, ID)).toBe(true);
    // A link that failed with nothing made is no one's: an error, as before.
    const none = with_('linkSync', () => (...args: unknown[]) => {
      throw eio(args[1]);
    });
    expect(() => piConversationStore({ fs: none }).lock(join(home, 'other'), ID)).toThrow(/EIO/);
  });

  it('D16-C1: what is only litter after the link (the temporary file, the entries below) cannot fail the lock', () => {
    mkdirSync(lockDir());
    writeFileSync(
      join(lockDir(), '1.owner'),
      JSON.stringify({ v: 1, pid: process.pid, start: 'gone' })
    );
    const fs = with_('rmSync', () => (...args: unknown[]) => {
      throw eio(args[0]);
    });
    const held = piConversationStore({ fs }).lock(dir, ID);
    expect('owner' in held).toBe(true);
    expect(piConversationStore().lock(dir, ID)).toEqual({ busy: expect.any(String) });
    // The litter stays (below the top, it counts for nothing), the next taker removes it.
    expect(
      readdirSync(lockDir())
        .filter((name) => name.endsWith('.owner'))
        .sort()
    ).toEqual(['1.owner', '2.owner']);
    if ('owner' in held) held.release();
    expect('owner' in piConversationStore().lock(dir, ID)).toBe(true);
    // Lock entries: only the current one (the temporary file of the earlier try is litter that
    // no taker removes: it may be another taker's, about to be linked).
    expect(readdirSync(lockDir()).filter((name) => !name.endsWith('.tmp'))).toEqual(['3.owner']);
  });

  it('R6-C: a release whose durable write fails throws and can be tried again, leaving nothing beside; once done, done', () => {
    let fail = true;
    const fs = with_('renameSync', (real) => (...args: unknown[]) => {
      if (fail && String(args[1]).endsWith('.released')) throw eio(args[1]);
      return real(...args);
    });
    const held = piConversationStore({ fs }).lock(dir, ID);
    if (!('owner' in held)) throw new Error('not taken');
    expect(() => held.release()).toThrow(/EIO/);
    expect(piConversationStore().lock(dir, ID)).toEqual({ busy: expect.any(String) });
    expect(readdirSync(lockDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    fail = false;
    held.release();
    expect(readdirSync(lockDir()).sort()).toEqual(['1.owner', '1.released']);
    held.release();
    expect('owner' in piConversationStore().lock(dir, ID)).toBe(true);
  });

  it('R6-C: the recovery lets its lock go whatever it did, and says it when it cannot (lockKept), never in place of what it did', () => {
    write(ORIGINAL, branched() + CUT);
    const fs = with_('renameSync', (real) => (...args: unknown[]) => {
      if (String(args[1]).endsWith('.released')) throw eio(args[1]);
      return real(...args);
    });
    const store = piConversationStore({ fs, now: () => new Date('2026-11-04T12:00:00.000Z') });
    const preview = store.recover(dir, ID);
    expect(preview).toMatchObject({ status: 'preview', lockKept: 'EIO' });
    // Kept by this process, as by the procedure's own: free once its holder is gone.
    expect(piConversationStore().recover(dir, ID)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/open in Switch or being recovered/),
    });
    for (const name of readdirSync(lockDir()).filter((entry) => entry.endsWith('.owner')))
      writeFileSync(
        join(lockDir(), name),
        JSON.stringify({ v: 1, pid: process.pid, start: 'gone' })
      );
    if (preview.status !== 'preview') throw new Error('no preview');
    const done = store.recover(dir, ID, preview.digest);
    expect(done).toMatchObject({ status: 'recovered', lockKept: 'EIO' });
    expect(mapped().file).toBe(`2026-11-04T12-00-00-000Z_${ID}.jsonl`);
  });

  it('D-15: an empty directory as procfs (ps given) is no procfs: process starts come from ps, environments cannot be seen, and a table ps did not give whole is not an empty one', () => {
    const proc = join(home, 'empty-proc');
    mkdirSync(proc);
    const store = piConversationStore({ procRoot: proc, ps: fakePs([process.pid]) });
    expect(store.processStart(process.pid)?.start).toMatch(/^ps:\S/);
    expect(store.stillRuns(process.pid, store.processStart(process.pid)?.start)).toBe(true);
    // A launch with a group of its own: its Pi and its markers cannot be seen without procfs.
    const run = join(home, 'run', 'launch-ps');
    mkdirSync(run, { recursive: true });
    const base = { v: 1, instance: 'i-1', run: 1, toolCallId: 'c1', marker: 'i-1:c1' };
    writeFileSync(
      join(run, 'processes.jsonl'),
      `${JSON.stringify({ ...base, event: 'intent' })}\n${JSON.stringify({ ...base, event: 'spawn', pid: 2_000_000, pgid: 2_000_000 })}\n`
    );
    const seen = store.launchLeft(run, null).join('; ');
    expect(seen).toMatch(/whether the Pi of launch .* runs cannot be seen/);
    expect(seen).toMatch(/whether the commands of launch .* run cannot be seen/);
    expect(seen).not.toMatch(/process groups of launch .* cannot be seen/);
    for (const how of ['fail', 'blank', 'garbage'] as const)
      expect(
        piConversationStore({ procRoot: proc, ps: fakePs([process.pid], how) })
          .launchLeft(run, null)
          .join('; ')
      ).toMatch(/the process groups of launch .* cannot be seen/);
    // Without `ps` given, an empty root someone passed is not replaced by `ps`, and it is no
    // procfs either (R7-C, Codex A12: `piProcSource` says `none`): no process can be told there,
    // never "none of it runs".
    expect(() => piConversationStore({ procRoot: proc }).processStart(process.pid)).toThrow(
      /no source/
    );
    expect(piConversationStore({ procRoot: proc }).stillRuns(process.pid, '1')).toBe(true);
    expect(piConversationStore({ procRoot: proc }).launchLeft(run, null).join('; ')).toMatch(
      /process groups of launch .* cannot be seen/
    );
  });

  // R7-A (joint round 3): the table of the store's `ps` is read whole or not at all: a state `ps`
  // does not print, or one PID twice, is a table not read, never a group without members.
  it.each([
    ['a state ps does not print', `${process.pid} ${process.pid} Qq`],
    ['a PID twice', `${process.pid} ${process.pid} S\n${process.pid} ${process.pid} S`],
  ])('R7-A: takes a ps table with %s for one not read', (_name, rows) => {
    const proc = join(home, 'empty-proc');
    mkdirSync(proc);
    const script = join(home, 'rows-ps');
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${rows.split('\n').join("' '")}'\n`, {
      mode: 0o755,
    });
    const run = join(home, 'run', 'launch-rows');
    mkdirSync(run, { recursive: true });
    const base = { v: 1, instance: 'i-1', run: 1, toolCallId: 'c1', marker: 'i-1:c1' };
    writeFileSync(
      join(run, 'processes.jsonl'),
      `${JSON.stringify({ ...base, event: 'spawn', pid: 2_000_000, pgid: 2_000_000 })}\n`
    );
    expect(
      piConversationStore({ procRoot: proc, ps: script }).launchLeft(run, null).join('; ')
    ).toMatch(/the process groups of launch .* cannot be seen/);
  });
});

describe('joint round 4 (FAP): what the store’s ps says without procfs', () => {
  /**
   * The system's `ps` with a time zone of the system's (U-1; Fable F1-02, Opus FAP-A3c): like
   * libc, `$TZ` when it is set, else the zone in `zone` (the machine's `/etc/localtime`, which a
   * laptop that travels changes).
   */
  function zonedPs(): { ps: string; zone: string } {
    const at = mkdtempSync(join(home, 'ps-tz-'));
    const zone = join(at, 'zone');
    writeFileSync(zone, 'UTC');
    const ps = join(at, 'ps');
    writeFileSync(
      ps,
      `#!/bin/sh\nif [ -z "$TZ" ]; then TZ=$(cat '${zone}'); export TZ; fi\nexec ps "$@"\n`,
      { mode: 0o755 }
    );
    return { ps, zone };
  }

  it('U-1 control: the stand-in ps prints another start for the same process once the system’s zone changes', () => {
    const { ps, zone } = zonedPs();
    const read = () =>
      spawnSync(ps, ['-o', 'lstart=', '-p', String(process.pid)], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      }).stdout.trim();
    const before = read();
    writeFileSync(zone, 'Asia/Tokyo');
    expect(read()).not.toBe(before);
  });

  it('U-1: a zone change of the system leaves a live holder live: its lock is not taken over', () => {
    const { ps, zone } = zonedPs();
    const proc = join(home, 'no-proc');
    const store = piConversationStore({ procRoot: proc, ps });
    const own = store.processStart(process.pid)?.start;
    expect(own).toMatch(/^ps:\S/);
    const held = store.lock(dir, ID);
    expect('release' in held).toBe(true);
    writeFileSync(zone, 'Asia/Tokyo');
    const other = piConversationStore({ procRoot: proc, ps });
    expect(other.processStart(process.pid)?.start).toBe(own);
    expect(other.stillRuns(process.pid, own)).toBe(true);
    expect(other.lock(dir, ID)).toEqual({ busy: expect.stringMatching(/held by process/) });
    expect(readdirSync(join(dir, `${ID}.lock`))).toEqual(['1.owner']);
  });

  it('U-1: the store as pi-recover.mjs holds it reads starts in UTC too', async () => {
    const { ps, zone } = zonedPs();
    const done = await finished(
      nodeWith(
        [
          'const [ps, zone, pid, proc] = process.argv.slice(1);',
          'const store = piConversationStore({ procRoot: proc, ps });',
          'const before = store.processStart(Number(pid)).start;',
          'fs.writeFileSync(zone, "Asia/Tokyo");',
          'process.stdout.write(JSON.stringify([before, store.processStart(Number(pid)).start]));',
        ].join('\n'),
        [ps, zone, String(process.pid), join(home, 'no-proc')]
      )
    );
    expect(done.code).toBe(0);
    const [before, after] = JSON.parse(done.out) as [string, string];
    expect(before).toMatch(/^ps:\S/);
    expect(after).toBe(before);
    expect(piRecoverSource()).toContain(storeFunction.toString());
  });

  /**
   * U-2 (Codex FAP-C01, Fable F1-04): the system's `ps`, except for the holder `HOLDER`, for which
   * it exits 1 with nothing on stdout: `quiet` (nothing on stderr either: no such process) or with
   * a diagnostic on stderr (`ps` failed: the process is not known). Takers (this process, a plain
   * `node`) still read their own identity.
   */
  const HOLDER = 2_000_001;
  function exitOnePs(how: 'quiet' | 'diagnostic'): string {
    const script = join(mkdtempSync(join(home, 'ps-rc1-')), 'ps');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'prev=; pid=',
        'for a in "$@"; do [ "$prev" = "-p" ] && pid="$a"; prev="$a"; done',
        `if [ "$pid" != "${HOLDER}" ]; then exec ps "$@"; fi`,
        ...(how === 'diagnostic' ? ['echo "ps: failed to read the process table" >&2'] : []),
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    return script;
  }
  const holder = (start: string) => {
    const lock = join(dir, `${ID}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, '1.owner'), JSON.stringify({ v: 1, pid: HOLDER, start }));
    return lock;
  };

  it.each([
    ['quiet: no such process, the lock is free', 'quiet', true],
    ['diagnostic: ps failed, the holder is not known, the lock is held', 'diagnostic', false],
  ] as const)('U-2: ps exits 1 with nothing printed, %s', (_name, how, free) => {
    const lock = holder('ps:Fri Nov  6 10:00:00 2026');
    const store = piConversationStore({ procRoot: join(home, 'no-proc'), ps: exitOnePs(how) });
    expect(store.stillRuns(HOLDER, 'ps:Fri Nov  6 10:00:00 2026')).toBe(!free);
    if (how === 'quiet') expect(store.processStart(HOLDER)).toBeNull();
    else expect(() => store.processStart(HOLDER)).toThrow(/ps failed \(1\)/);
    const taken = store.lock(dir, ID);
    expect('release' in taken).toBe(free);
    expect(existsSync(join(lock, '2.owner'))).toBe(free);
  });

  it('U-2: the store as pi-recover.mjs holds it keeps a lock whose holder ps failed on', async () => {
    holder('ps:Fri Nov  6 10:00:00 2026');
    const done = await finished(
      nodeWith(
        [
          'const [ps, dir, id, proc] = process.argv.slice(1);',
          'const held = piConversationStore({ procRoot: proc, ps }).lock(dir, id);',
          'process.stdout.write("release" in held ? "held" : "busy");',
        ].join('\n'),
        [exitOnePs('diagnostic'), dir, ID, join(home, 'no-proc')]
      )
    );
    expect(done).toMatchObject({ code: 0, out: 'busy' });
  });
});

describe('joint round 5 (O-1 A, O-2 B, O-9 A′): the proof of Pi’s exit, groups whose number was given again, launches being made', () => {
  const runRoot = () => join(home, 'run');
  const ownStart = () => piConversationStore().ownIdentity().start ?? '0';
  /** This process with a start it never had: a Switch that is gone (as in R2-B). */
  const deadOwner = () => ({ pid: process.pid, start: String(BigInt(ownStart()) + 1n) });
  const liveOwner = () => ({ pid: process.pid, start: ownStart() });
  function launchDir(name: string, owner: Record<string, unknown> | null): string {
    const at = join(runRoot(), name);
    mkdirSync(at, { recursive: true });
    if (owner)
      writeFileSync(join(at, 'owner.json'), JSON.stringify({ v: 1, piSessionId: ID, ...owner }));
    return at;
  }
  const pending = (at: string, extra: Record<string, unknown> = {}) => ({
    runDir: at,
    registry: join(at, 'processes.jsonl'),
    bridgeConfig: join(at, 'config.json'),
    ...extra,
  });
  /** A live process (its own group and session) with `env` and `args` after its script. */
  function live(env: Record<string, string>, script = 'exec sleep 60', args: string[] = []) {
    const child = spawn('/bin/sh', ['-c', script, 'sh', ...args], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', ...env },
    });
    child.unref();
    const pid = child.pid as number;
    started.push(pid);
    return pid;
  }
  const gone = (pid: number) => {
    const found = piConversationStore().processStart(pid);
    return found === null || found.zombie;
  };
  async function kill(pid: number) {
    process.kill(-pid, 'SIGKILL');
    await until(() => gone(pid), `process ${pid} gone`);
  }
  const startOf = (pid: number) => piConversationStore().processStart(pid)?.start as string;
  const lstartOf = (pid: number) =>
    piConversationStore({ procRoot: join(home, 'no-proc'), ps: 'ps' })
      .processStart(pid)
      ?.start.slice(3) as string;
  const labelFor = () =>
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  /** The bridge's records of one shell (`pi-bash.ts`), `spawn` with `fields` when `pid` is given. */
  function shell(
    toolCallId: string,
    marker: string,
    pid?: number,
    fields: Record<string, unknown> = {}
  ): unknown[] {
    const base = { v: 1, instance: 'i-1', run: 1, toolCallId, marker };
    const label = fields.label;
    return [
      { ...base, event: 'intent', ...(label === undefined ? {} : { label }) },
      ...(pid === undefined ? [] : [{ ...base, event: 'spawn', pid, pgid: pid, ...fields }]),
    ];
  }
  const register = (at: string, records: unknown[]) =>
    writeFileSync(
      join(at, 'processes.jsonl'),
      records.map((record) => `${JSON.stringify(record)}\n`).join('')
    );
  const reasonOf = (store: PiConversationStore) => {
    const result = store.recover(dir, ID);
    return result.status === 'refused' ? result.reason : result.status;
  };
  const noProc = () => piConversationStore({ procRoot: join(home, 'no-proc'), ps: 'ps' });

  // ------------------------------------------------------------------------------------------
  // O-1 A: the record.

  it('O-1 A: piExited is true or absent, never of another shape; a record cut off is no record', () => {
    const store = piConversationStore();
    for (const piExited of [false, 'yes', 1, null]) {
      writeFileSync(
        join(dir, `${ID}.cleanup.json`),
        JSON.stringify({ v: 1, launches: [pending('/r', { piExited })] })
      );
      expect(store.readCleanup(dir, ID)).toEqual({
        problem: expect.stringMatching(/not a record/),
      });
    }
    store.addCleanup(dir, ID, [pending('/r', { piExited: true })]);
    expect(store.readCleanup(dir, ID)).toEqual({ launches: [pending('/r', { piExited: true })] });
    // A record written before O-1 A (no field) reads as before.
    writeFileSync(
      join(dir, `${ID}.cleanup.json`),
      JSON.stringify({ v: 1, launches: [pending('/r')] })
    );
    expect(store.readCleanup(dir, ID)).toEqual({ launches: [pending('/r')] });
    // A write cut off (`writeDurably` renames a whole file, so only a damaged one can be seen).
    const whole = JSON.stringify({ v: 1, launches: [pending('/r', { piExited: true })] });
    writeFileSync(join(dir, `${ID}.cleanup.json`), whole.slice(0, Math.floor(whole.length / 2)));
    expect(store.readCleanup(dir, ID)).toEqual({ problem: expect.stringMatching(/not a record/) });
    expect(reasonOf(store)).toMatch(/could not confirm that the processes of its last session/);
  });

  it('O-1 A: the record merges an entry it lists already, monotonically: the proof stays whatever is written after it, a contradicting entry changes nothing', () => {
    const store = piConversationStore();
    const owner = { pid: 4242, start: '1234' };
    store.addCleanup(dir, ID, [pending('/r1')]);
    // Added to the entry that is there.
    store.addCleanup(dir, ID, [pending('/r1', { owner, piExited: true })]);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [pending('/r1', { owner, piExited: true })],
    });
    // A later write of the older version loses nothing.
    store.addCleanup(dir, ID, [pending('/r1'), pending('/r2')]);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [pending('/r1', { owner, piExited: true }), pending('/r2')],
    });
    // Another registry under the same directory contradicts the entry: nothing of it moves.
    store.addCleanup(dir, ID, [{ ...pending('/r2'), registry: '/other', piExited: true }]);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [pending('/r1', { owner, piExited: true }), pending('/r2')],
    });
    // `ended` keeps the proof; `drop` takes the entry.
    expect(store.settleCleanup(dir, ID, '/r1', 'ended')).toBe(true);
    expect(store.readCleanup(dir, ID)).toEqual({
      launches: [pending('/r1', { owner, piExited: true, ended: true }), pending('/r2')],
    });
    store.addCleanup(dir, ID, [pending('/r1')]);
    expect(store.readCleanup(dir, ID)).toMatchObject({
      launches: [{ runDir: '/r1', piExited: true, ended: true }, { runDir: '/r2' }],
    });
  });

  // ------------------------------------------------------------------------------------------
  // O-1 A (R5P-01): the recovery, the whole of it.

  it.each([
    ['its Switch still runs (it let the conversation go after the record)', 'live'],
    ['its Switch is gone', 'dead'],
  ] as const)(
    'O-1 A (procfs): a launch whose record keeps Pi’s exit, %s: refused while a group of it lives, recovered once it is gone',
    async (_name, host) => {
      write(ORIGINAL, branched() + CUT);
      const owner = host === 'live' ? liveOwner() : deadOwner();
      const at = launchDir('launch-1', owner);
      const marker = `i-1:c1@${home}`;
      const group = live({}, 'env -i /bin/sleep 60 & wait');
      await until(() => !gone(group), 'group');
      register(at, shell('c1', marker, group, { starttime: startOf(group) }));
      const store = piConversationStore();
      store.addCleanup(dir, ID, [pending(at, { owner, piExited: true })]);
      expect(reasonOf(store)).toMatch(
        new RegExp(
          `commands of its last session are gone \\(process group\\(s\\) ${group} of launch`
        )
      );
      expect(reasonOf(store)).not.toMatch(/Pi of launch|belongs to Switch process/);
      await kill(group);
      expect(reasonOf(store)).toBe('preview');
      // Without the proof (a record of before), the same launch refuses as it always did.
      writeFileSync(
        join(dir, `${ID}.cleanup.json`),
        JSON.stringify({ v: 1, launches: [pending(at, { owner })] })
      );
      expect(reasonOf(store)).toMatch(/could not confirm that the processes of its last session/);
    }
  );

  it('O-1 A (procfs): the proof spares the search for Pi only: an intended shell, a marked process outside the old group, an unreadable registry, a launch gone still refuse', async () => {
    write(ORIGINAL, branched() + CUT);
    const at = launchDir('launch-1', deadOwner());
    const store = piConversationStore();
    store.addCleanup(dir, ID, [pending(at, { owner: deadOwner(), piExited: true })]);
    // Intent only (Pi died between the intent and the spawn): found by its marker.
    const intended = live({ SWITCH_PI_TC: `i-1:c2@${home}` });
    await until(() => !gone(intended), 'intended shell');
    register(at, shell('c2', `i-1:c2@${home}`));
    expect(reasonOf(store)).toMatch(
      new RegExp(`command\\(s\\) of launch .* still run \\(process ${intended}`)
    );
    await kill(intended);
    expect(reasonOf(store)).toBe('preview');
    // A process with the marker of a recorded shell, outside that shell's (empty) group.
    const old = live({}, 'exit 0');
    await until(() => gone(old), 'old shell');
    const escaped = live({ SWITCH_PI_TC: `i-1:c3@${home}` });
    await until(() => !gone(escaped), 'escaped');
    register(at, shell('c3', `i-1:c3@${home}`, old, { starttime: '1' }));
    expect(reasonOf(store)).toMatch(
      new RegExp(`command\\(s\\) of launch .* still run \\(process ${escaped}`)
    );
    await kill(escaped);
    expect(reasonOf(store)).toBe('preview');
    // A registry that cannot be read.
    rmSync(join(at, 'processes.jsonl'));
    mkdirSync(join(at, 'processes.jsonl'));
    expect(reasonOf(store)).toMatch(/the registry of launch .* cannot be read \(EISDIR\)/);
    // A launch directory gone (its registry with it): its commands cannot be told over.
    rmSync(at, { recursive: true });
    expect(reasonOf(store)).toMatch(
      /launch .* is gone and the record does not say its commands ended/
    );
  });

  it('O-1 A (R5P-01, ps): with a registry of shells, the recovery passes once nothing of them is seen; a labelled shell alive, one without a label, a group alive refuse', async () => {
    write(ORIGINAL, branched() + CUT);
    const owner = { pid: process.pid, start: 'ps:Mon Jan  1 00:00:00 2024' };
    const at = launchDir('launch-ps', owner);
    const store = noProc();
    store.addCleanup(dir, ID, [pending(at, { owner, piExited: true })]);
    const old = live({}, 'exit 0');
    await until(() => gone(old), 'old shell');
    const label = labelFor();
    register(at, [
      ...shell('c1', 'i-1:c1', old, { label, lstart: 'Mon Jan  1 00:00:01 2024' }),
      { v: 1, instance: 'i-1', toolCallId: 'c1', event: 'exit', pid: old, code: 0, signal: null },
    ]);
    expect(reasonOf(store)).toBe('preview');
    // A shell recorded only as intended, alive with its label in its command line.
    const intendedLabel = labelFor();
    const intended = live({}, 'sleep 60; :', [intendedLabel]);
    await until(() => !gone(intended), 'labelled shell');
    register(at, [
      ...shell('c1', 'i-1:c1', old, { label, lstart: 'Mon Jan  1 00:00:01 2024' }),
      ...shell('c2', 'i-1:c2', undefined, { label: intendedLabel }),
    ]);
    expect(reasonOf(store)).toMatch(
      new RegExp(`command\\(s\\) of launch .* still run \\(process ${intended}`)
    );
    await kill(intended);
    expect(reasonOf(store)).toBe('preview');
    // One without a label (a registry written before D-18) cannot be seen without procfs.
    register(at, shell('c4', 'i-1:c4'));
    expect(reasonOf(store)).toMatch(/whether the commands of launch .* run cannot be seen/);
    // A group that lives (no start recorded for its leader).
    const group = live({});
    await until(() => !gone(group), 'group');
    register(at, shell('c5', 'i-1:c5', group, { label: labelFor() }));
    expect(reasonOf(store)).toMatch(new RegExp(`process group\\(s\\) ${group} of launch`));
    await kill(group);
    expect(reasonOf(store)).toBe('preview');
  });

  it('O-1 A (R5P-01): the procedure as pi-recover.mjs holds it, in another process: the same answers', async () => {
    write(ORIGINAL, branched() + CUT);
    const owner = { pid: process.pid, start: 'ps:Mon Jan  1 00:00:00 2024' };
    const at = launchDir('launch-ps', owner);
    piConversationStore().addCleanup(dir, ID, [pending(at, { owner, piExited: true })]);
    const recoverIn = async (procRoot: string, ps?: string) => {
      const done = await finished(
        nodeWith(
          [
            'const [dir, id, procRoot, ps] = process.argv.slice(1);',
            'const store = piConversationStore({ procRoot, ...(ps ? { ps } : {}) });',
            'const result = store.recover(dir, id);',
            'process.stdout.write(result.status === "refused" ? result.reason : result.status);',
          ].join('\n'),
          [dir, ID, procRoot, ...(ps ? [ps] : [])]
        )
      );
      expect(done.code).toBe(0);
      return done.out;
    };
    const ps = join(home, 'no-proc');
    const old = live({}, 'exit 0');
    await until(() => gone(old), 'old shell');
    const label = labelFor();
    register(at, shell('c1', 'i-1:c1', old, { label }));
    expect(await recoverIn(ps, 'ps')).toBe('preview');
    const intendedLabel = labelFor();
    const intended = live({}, 'sleep 60; :', [intendedLabel]);
    await until(() => !gone(intended), 'labelled shell');
    register(at, shell('c2', 'i-1:c2', undefined, { label: intendedLabel }));
    expect(await recoverIn(ps, 'ps')).toMatch(/command\(s\) of launch .* still run/);
    await kill(intended);
    rmSync(join(at, 'processes.jsonl'));
    mkdirSync(join(at, 'processes.jsonl'));
    expect(await recoverIn(ps, 'ps')).toMatch(/registry of launch .* cannot be read/);
    // On procfs (the record's host by its procfs start), a live group of the launch.
    rmSync(join(at, 'processes.jsonl'), { recursive: true });
    writeFileSync(
      join(dir, `${ID}.cleanup.json`),
      JSON.stringify({ v: 1, launches: [pending(at, { owner: deadOwner(), piExited: true })] })
    );
    const group = live({}, 'env -i /bin/sleep 60 & wait');
    await until(() => !gone(group), 'group');
    register(at, shell('c3', `i-1:c3@${home}`, group, { starttime: startOf(group) }));
    expect(await recoverIn('/proc')).toMatch(new RegExp(`process group\\(s\\) ${group} of launch`));
    await kill(group);
    expect(await recoverIn('/proc')).toBe('preview');
    // A record without the proof: refused there too.
    writeFileSync(
      join(dir, `${ID}.cleanup.json`),
      JSON.stringify({ v: 1, launches: [pending(at, { owner })] })
    );
    expect(await recoverIn('/proc')).toMatch(
      /could not confirm that the processes of its last session/
    );
  }, 30_000);

  // ------------------------------------------------------------------------------------------
  // O-2 B (FAP-06, R5P-02): a group whose number was given again.

  it('O-2 B (procfs): a group whose leader is another process (another start) is not left; the same start, no start, or no leader is', async () => {
    const at = launchDir('launch-reuse', deadOwner());
    const groupReason = () =>
      piConversationStore()
        .launchLeft(at, null)
        .filter((reason) => /process group/.test(reason))
        .join('; ');
    const leader = live({});
    await until(() => !gone(leader), 'leader');
    const start = startOf(leader);
    register(at, shell('c1', 'i-1:c1', leader, { starttime: String(BigInt(start) + 1n) }));
    expect(groupReason()).toBe('');
    register(at, shell('c1', 'i-1:c1', leader, { starttime: start }));
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${leader} of launch`));
    register(at, shell('c1', 'i-1:c1', leader, {}));
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${leader} of launch`));
    // A start not in procfs's form is no identity: the group counts.
    register(at, shell('c1', 'i-1:c1', leader, { starttime: 'x1' }));
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${leader} of launch`));
    // No leader left, a member alive: whatever start was recorded, counted.
    const orphaned = live({}, 'sleep 60 & exit 0');
    await until(() => gone(orphaned), 'the leader gone');
    register(at, shell('c2', 'i-1:c2', orphaned, { starttime: '1' }));
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${orphaned} of launch`));
  });

  it.each([
    ['the older first', false],
    ['the newer first', true],
  ] as const)(
    'O-2 B (R5P-02, %s): two shells recorded with one group number: the newer, whose start the leader has, still counts',
    async (_name, newerFirst) => {
      const at = launchDir('launch-ab', deadOwner());
      const leader = live({});
      await until(() => !gone(leader), 'leader');
      const start = startOf(leader);
      const older = shell('a', 'i-1:a', leader, { starttime: String(BigInt(start) + 1n) });
      const newer = shell('b', 'i-1:b', leader, { starttime: start });
      register(at, newerFirst ? [...newer, ...older] : [...older, ...newer]);
      expect(piConversationStore().launchLeft(at, null).join('; ')).toMatch(
        new RegExp(`process group\\(s\\) ${leader} of launch`)
      );
      // The older alone is not.
      register(at, older);
      expect(piConversationStore().launchLeft(at, null).join('; ')).not.toMatch(/process group/);
    }
  );

  it('O-2 B (ps): another lstart is another process; the same second, or a second lstart record for the shell, still counts', async () => {
    const at = launchDir('launch-reuse-ps', deadOwner());
    const groupReason = () =>
      noProc()
        .launchLeft(at, null)
        .filter((reason) => /process group/.test(reason))
        .join('; ');
    const leader = live({});
    await until(() => !gone(leader), 'leader');
    const lstart = lstartOf(leader);
    expect(lstart).toMatch(/^\w{3} \w{3} /);
    register(at, shell('c1', 'i-1:c1', leader, { lstart: 'Mon Jan  1 00:00:00 2024' }));
    expect(groupReason()).toBe('');
    register(at, shell('c1', 'i-1:c1', leader, { lstart }));
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${leader} of launch`));
    register(at, [
      ...shell('c1', 'i-1:c1', leader, {}),
      {
        v: 1,
        instance: 'i-1',
        toolCallId: 'c1',
        event: 'lstart',
        pid: leader,
        lstart: 'Mon Jan  1 00:00:00 2024',
      },
      {
        v: 1,
        instance: 'i-1',
        toolCallId: 'c1',
        event: 'lstart',
        pid: leader,
        lstart: 'Mon Jan  1 00:00:02 2024',
      },
    ]);
    expect(groupReason()).toMatch(new RegExp(`process group\\(s\\) ${leader} of launch`));
  });

  // ------------------------------------------------------------------------------------------
  // O-9 A′ (S4-11): launch directories being made, at the recovery.

  it('O-9 A′: a launch being made holds up the recovery only while it is this conversation’s and its Switch runs, or, without a whole owner, while what runs cannot be seen', () => {
    write(ORIGINAL, branched() + CUT);
    const store = piConversationStore();
    const at = launchDir('.preparing-0b1c', null);
    const own = (owner: Record<string, unknown>) =>
      writeFileSync(join(at, 'owner.json'), JSON.stringify({ v: 1, piSessionId: ID, ...owner }));
    // After mkdir: no owner. procfs that sees every process (this one): nothing of it runs.
    const proc = mkdtempSync(join(home, 'proc-'));
    symlinkSync(`/proc/${process.pid}`, join(proc, String(process.pid)));
    const seen = piConversationStore({ procRoot: proc });
    expect(reasonOf(seen)).toBe('preview');
    // Without procfs, what runs cannot be seen: refused (the caution of a launch without owner).
    expect(reasonOf(noProc())).toMatch(
      /is being made, has no whole owner .* its processes cannot be seen/
    );
    // In the write of the owner (cut off): the same as none.
    writeFileSync(join(at, 'owner.json'), '{"v":1,"pid":');
    expect(reasonOf(seen)).toBe('preview');
    expect(reasonOf(noProc())).toMatch(/has no whole owner/);
    // A whole owner: of a Switch that is gone, passed over; of another conversation, too.
    own(deadOwner());
    expect(reasonOf(store)).toBe('preview');
    // Without procfs a start read with `ps` (another one: gone); one read on procfs cannot be
    // compared there, so it is not told gone: refused.
    expect(reasonOf(noProc())).toMatch(/is being made by Switch process/);
    own({ pid: process.pid, start: 'ps:Mon Jan  1 00:00:00 2024' });
    expect(reasonOf(noProc())).toBe('preview');
    own({ ...liveOwner(), piSessionId: 'another' });
    expect(reasonOf(store)).toBe('preview');
    // This conversation's, its Switch alive (or not told gone): refused.
    own(liveOwner());
    expect(reasonOf(store)).toMatch(/is being made by Switch process \d+, which still runs/);
    // Renamed for removal (joint round 4 made launches under that name too): passed over.
    renameSync(at, join(runRoot(), '.removed-0b1c'));
    expect(reasonOf(store)).toBe('preview');
  });
});
