import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeErrors, ServerLogCursor, ServerLogWatch } from './server-log.ts';

const dirs: string[] = [];

function logFile(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-server-log-'));
  dirs.push(dir);
  const file = path.join(dir, 'switch-core.log');
  writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
  return file;
}

function append(file: string, lines: string[]): void {
  appendFileSync(file, lines.map((line) => `${line}\n`).join(''));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(status: string, message: string, requestId?: string): string {
  return JSON.stringify({
    timestamp: '2026-10-19T10:00:00.000+00:00',
    status,
    message,
    logger: { name: 'switch_core.test' },
    ...(requestId ? { request_id: requestId } : {}),
  });
}

const tagger = { tagRequests: (_tag: string | null) => {} };

describe('server log cursor', () => {
  it('reads only what was written after it, at error level and above', () => {
    const file = logFile([record('error', 'at boot, before the lane')]);
    const cursor = ServerLogCursor.atEnd(file);
    append(file, [
      record('info', 'ordinary'),
      record('warning', 'degraded'),
      record('error', 'delivery failed', 'e2e-abc123a-3'),
      record('critical', 'loop died'),
    ]);
    const errors = cursor.take();
    expect(errors.map((error) => error.message)).toEqual(['delivery failed', 'loop died']);
    expect(describeErrors(errors, 'e2e-abc123a')).toContain(
      "this scenario's request e2e-abc123a-3"
    );
    expect(describeErrors(errors, 'e2e-abc123a')).toContain('loop died (background work)');
    expect(cursor.take()).toEqual([]);
  });

  it('leaves a line the server is still writing for the next read', () => {
    const file = logFile([record('info', 'booted')]);
    const cursor = ServerLogCursor.atEnd(file);
    const line = record('error', 'half written');
    appendFileSync(file, line.slice(0, 20));
    expect(cursor.take()).toEqual([]);
    appendFileSync(file, `${line.slice(20)}\n`);
    expect(cursor.take().map((error) => error.message)).toEqual(['half written']);
  });

  it('counts a traceback that bypassed logging, whenever it was printed, and ignores other output', () => {
    const file = logFile([record('info', 'booted')]);
    const cursor = ServerLogCursor.atEnd(file);
    append(file, [
      'DeprecationWarning: something a dependency still does',
      'Exception in thread mm-ws-agent:',
      'Traceback (most recent call last):',
      '  File "adapter.py", line 1, in _run_ws',
      'RuntimeError: boom',
    ]);
    expect(cursor.take().map((error) => error.message)).toEqual([
      'Exception in thread mm-ws-agent:',
      'Traceback (most recent call last):',
    ]);
  });

  it('refuses a log that is not JSON, rather than finding no errors in it', () => {
    const file = logFile(['2026-10-19T10:00:02 ERROR [switch_core] text format']);
    expect(() => ServerLogCursor.atEnd(file)).toThrow(/LOG_FORMAT=json/);
  });

  it('refuses a log it cannot read, and one that shrank under it', () => {
    expect(() => ServerLogCursor.atEnd('/nonexistent/switch-core.log')).toThrow(
      /Cannot read the server log/
    );
    const file = logFile([record('info', 'booted'), record('info', 'more')]);
    const cursor = ServerLogCursor.atEnd(file);
    truncateSync(file, 10);
    expect(() => cursor.take()).toThrow(/rotated or truncated/);
  });
});

describe('server log watch', () => {
  it('sets aside what was logged between scenarios, for the end-of-lane sweep', async () => {
    const file = logFile([record('info', 'booted')]);
    const watch = new ServerLogWatch(file);
    append(file, [record('error', 'during setup')]);
    const observer = watch.begin(tagger, 'e2e-abc123b', 'some-scenario');
    append(file, [record('error', 'in the scenario', 'e2e-abc123b-1')]);
    observer.stop();
    expect(observer.errors(null, () => {})?.map((error) => error.message)).toEqual([
      'in the scenario',
    ]);
    append(file, [record('error', 'after the last scenario')]);
    expect((await watch.sweep())?.map((error) => error.message)).toEqual([
      'during setup',
      'after the last scenario',
    ]);
  });

  it("never lets an unreadable log replace the scenario's own failure", () => {
    const file = logFile([record('info', 'booted'), record('info', 'more')]);
    const watch = new ServerLogWatch(file);
    const observer = watch.begin(tagger, 'e2e-abc123b', 'some-scenario');
    truncateSync(file, 10);
    const said: string[] = [];
    expect(observer.errors(new Error('the scenario failed'), (line) => said.push(line))).toBe(null);
    expect(said.join('\n')).toMatch(/could not read the server log/);
    expect(() => observer.errors(null, () => {})).toThrow(/rotated or truncated/);
  });

  it('is off, reading nothing, without a log', async () => {
    const watch = new ServerLogWatch(null);
    expect(watch.begin(tagger, 'e2e-abc123b', 'some-scenario').errors(null, () => {})).toBe(null);
    expect(await watch.sweep()).toBe(null);
  });
});
