import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_MCP_EXTENSION, PI_NEVER_ARGS, PiArgsError, piArgs, type PiArgsInput } from './pi-args';
import { PI_MCP_SOURCE_PATH } from './pi-policy';
import { PI_VERSION_ARGS } from './pi-version';

const BRIDGE = '/state/switch/pi/bridge-0123abcd.mjs';
const SESSIONS = '/state/switch/pi/sessions';

const session = (overrides: Partial<Extract<PiArgsInput, { kind: 'session' }>> = {}) =>
  piArgs({
    kind: 'session',
    bridgePath: BRIDGE,
    sessionDir: SESSIONS,
    session: { id: 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f' },
    model: 'anthropic/claude-sonnet-4-5',
    ...overrides,
  });

const every: Array<[string, string[]]> = [
  ['session', session()],
  ['resumed session', session({ session: { file: '/state/switch/pi/sessions/x.jsonl' } })],
  ['discovery', piArgs({ kind: 'discovery', bridgePath: BRIDGE })],
  ['readiness', piArgs({ kind: 'readiness', provider: 'anthropic' })],
  ['version', piArgs({ kind: 'version' })],
];

describe('piArgs', () => {
  it('starts a session in RPC mode, offline, with only the bridge and then builtin:mcp, the project untrusted', () => {
    expect(session()).toEqual([
      '--mode',
      'rpc',
      '--offline',
      '-ne',
      '-e',
      BRIDGE,
      '-e',
      'builtin:mcp',
      '--no-approve',
      '--session-dir',
      SESSIONS,
      '--session-id',
      'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f',
      '--model',
      'anthropic/claude-sonnet-4-5',
    ]);
  });

  it('loads the bridge first, after -ne and before builtin:mcp, in every Pi that loads extensions (D-4 A)', () => {
    for (const args of [
      session(),
      session({ session: { file: '/s/x.jsonl' } }),
      piArgs({ kind: 'discovery', bridgePath: BRIDGE }),
    ]) {
      const extensions = args.flatMap((arg, at) => (arg === '-e' ? [args[at + 1]] : []));
      expect(extensions).toEqual([BRIDGE, PI_MCP_EXTENSION]);
      expect(args.indexOf('-ne')).toBeLessThan(args.indexOf('-e'));
      expect(args.filter((arg) => arg === '-ne')).toHaveLength(1);
      for (const flag of ['--offline', '--no-approve', '--mode']) expect(args).toContain(flag);
      expect(args[args.indexOf('--mode') + 1]).toBe('rpc');
    }
  });

  it('names the MCP extension as Pi names its tools’ source', () => {
    expect(PI_MCP_EXTENSION).toBe(PI_MCP_SOURCE_PATH);
  });

  it('resumes a transcript with --session, never a new id beside it', () => {
    const args = session({ session: { file: '/state/switch/pi/sessions/x.jsonl' } });
    expect(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2)).toEqual([
      '--session',
      '/state/switch/pi/sessions/x.jsonl',
    ]);
    expect(args).not.toContain('--session-id');
    expect(args).toContain('--session-dir');
  });

  it('discovers models with no conversation kept and no model chosen', () => {
    expect(piArgs({ kind: 'discovery', bridgePath: BRIDGE })).toEqual([
      '--mode',
      'rpc',
      '--offline',
      '-ne',
      '-e',
      BRIDGE,
      '-e',
      'builtin:mcp',
      '--no-approve',
      '--no-session',
    ]);
  });

  it('asks one provider about sign-in offline, never refreshing a login', () => {
    expect(piArgs({ kind: 'readiness', provider: 'amazon-bedrock' })).toEqual([
      'auth',
      'check',
      '--provider',
      'amazon-bedrock',
      '--json',
      '--no-refresh',
      '--offline',
    ]);
  });

  it('is what the version check asks with', () => {
    expect(piArgs({ kind: 'version' })).toEqual(['--version', '--offline']);
    expect(PI_VERSION_ARGS).toEqual(piArgs({ kind: 'version' }));
  });

  it.each(every)(
    'never gives Pi --raw, --no-skills or another argument it must not have (%s)',
    (_, args) => {
      for (const never of PI_NEVER_ARGS) expect(args).not.toContain(never);
      expect(args).not.toContain('--raw');
      expect(args).not.toContain('--no-skills');
      expect(args).toContain('--offline');
    }
  );

  it.each([
    ['a model read as a flag', () => session({ model: '--raw' })],
    ['an empty model', () => session({ model: '' })],
    ['a model of two lines', () => session({ model: 'a\n--raw' })],
    ['a relative bridge', () => session({ bridgePath: 'bridge.mjs' })],
    ['a bridge read as a flag', () => piArgs({ kind: 'discovery', bridgePath: '-ne' })],
    ['a relative session directory', () => session({ sessionDir: 'sessions' })],
    ['a relative transcript', () => session({ session: { file: 'x.jsonl' } })],
    ['a session id Pi refuses', () => session({ session: { id: 'a/b' } })],
    ['a session id read as a flag', () => session({ session: { id: '-x' } })],
    ['a provider read as a flag', () => piArgs({ kind: 'readiness', provider: '--json' })],
    ['a provider with a space', () => piArgs({ kind: 'readiness', provider: 'a b' })],
  ])('refuses %s', (_, build) => {
    expect(build).toThrow(PiArgsError);
  });

  it('has no test mode: its code reads no environment and names no test, fake or mock (E12-03)', () => {
    const source = readFileSync(join(import.meta.dirname, 'pi-args.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // RegExp#test is how it checks values, not a mode.
      .replace(/\.test\(/g, '(');
    for (const word of [
      /process/,
      /\benv\b/i,
      /test/i,
      /fake/i,
      /mock/i,
      /VITEST/,
      /NODE_ENV/,
      /import\b/,
    ])
      expect(code, String(word)).not.toMatch(word);
  });
});
