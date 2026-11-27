import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, isAppEventChannel } from './event-channels';
import { isEventChannel } from './events';

const SRC = resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('isEventChannel', () => {
  const names = new Set(['session:created', 'room:health']);

  it('accepts an event name and the name with a topic', () => {
    expect(isEventChannel(names, 'session:created')).toBe(true);
    expect(isEventChannel(names, 'room:health.server-1')).toBe(true);
    expect(isEventChannel(names, 'room:health.a.b')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const channel of [
      '',
      'session',
      'session:created-x',
      'room:healthy.x',
      '.room:health',
      'x.room:health',
      'agents.list',
      'switch-console:rpc-channels',
    ])
      expect(isEventChannel(names, channel), channel).toBe(false);
  });
});

describe('the app event channels', () => {
  const definitions = files.flatMap(({ path, text }) =>
    path === 'shared/lib/ipc/events.ts'
      ? []
      : [...text.matchAll(/\bdefineEvent\s*[<(]/g)].map((match) => ({ path, index: match.index }))
  );

  it('hold every event defined in the source tree', () => {
    expect(definitions.length).toBeGreaterThan(50);
    for (const { path, index } of definitions) {
      // The glob in event-channels.ts loads only these modules.
      expect(path, 'an event defined outside the modules event-channels.ts loads').toMatch(
        /^shared\/(?:.+\/)?[^/]*(?:Events|-events)\.ts$/
      );
      const text = files.find((file) => file.path === path)!.text.slice(index);
      const name = /^defineEvent(?:<[\s\S]*?>)?\(\s*'([^']+)'\s*\)/.exec(text)?.[1];
      expect(name, `an event in ${path} not named by a string literal`).toBeDefined();
      expect(EVENT_NAMES.has(name!), name).toBe(true);
    }
  });

  it('hold every channel the renderer names to eventSend or eventOn directly', () => {
    const exported = new Map<string, string>();
    for (const { text } of files)
      for (const match of text.matchAll(
        /export const (\w+) = defineEvent(?:<[\s\S]*?>)?\(\s*'([^']+)'/g
      ))
        exported.set(match[1]!, match[2]!);

    const direct = files
      .filter(({ path }) => path.startsWith('renderer/') && path !== 'renderer/lib/ipc.ts')
      .flatMap(({ path, text }) =>
        [...text.matchAll(/\.event(?:Send|On)\(\s*([^,)]*)/g)].map((match) => ({
          path,
          argument: match[1]!.trim(),
        }))
      );
    expect(direct.length).toBeGreaterThan(0);
    for (const { path, argument } of direct) {
      const definition = /^(\w+)\.name$/.exec(argument)?.[1];
      expect(definition, `${path} passes ${argument}, not an event's name`).toBeDefined();
      const name = exported.get(definition!);
      expect(name, `${definition} is not an exported event`).toBeDefined();
      expect(isAppEventChannel(name!)).toBe(true);
    }
  });

  it('refuse a channel that is not an app event', () => {
    expect(isAppEventChannel('session:created')).toBe(true);
    expect(isAppEventChannel('switch-console:renderer-log')).toBe(true);
    expect(isAppEventChannel('agents.list')).toBe(false);
    expect(isAppEventChannel('switch-console:rpc-channels')).toBe(false);
  });
});
