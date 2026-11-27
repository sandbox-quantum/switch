import { describe, expect, it } from 'vitest';
import {
  systemdEnvironment,
  systemdExecArgument,
  systemdExecCommand,
  systemdText,
} from './systemd-unit';

describe('systemd unit values', () => {
  it('quotes exec arguments and escapes specifiers, variables, quotes and backslashes', () => {
    expect(systemdExecArgument('/opt/node')).toBe('"/opt/node"');
    expect(systemdExecArgument('/srv/100%h')).toBe('"/srv/100%%h"');
    expect(systemdExecArgument('/srv/$HOME/${USER}')).toBe('"/srv/$$HOME/$${USER}"');
    expect(systemdExecArgument('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
    expect(systemdExecArgument('a b ; c')).toBe('"a b ; c"');
    expect(systemdExecCommand(['/opt/node', '%i', '$X'])).toBe('"/opt/node" "%%i" "$$X"');
  });

  it('quotes environment assignments, escaping specifiers but not variables', () => {
    expect(systemdEnvironment('PATH=/usr/bin:/opt/100%u/bin')).toBe(
      '"PATH=/usr/bin:/opt/100%%u/bin"'
    );
    expect(systemdEnvironment('PATH=/opt/$x')).toBe('"PATH=/opt/$x"');
    expect(systemdEnvironment('PATH=/opt/"q"\\')).toBe('"PATH=/opt/\\"q\\"\\\\"');
  });

  it('escapes specifiers in free text', () => {
    expect(systemdText('Switch agent controller (server %n)')).toBe(
      'Switch agent controller (server %%n)'
    );
  });

  it.each([
    ['exec', systemdExecArgument],
    ['environment', systemdEnvironment],
    ['text', systemdText],
  ])('refuses newlines and other control characters in %s values', (_kind, write) => {
    expect(() => write('/opt/node\nExecStartPre=/bin/evil')).toThrow(/control characters/);
    expect(() => write('a\rb')).toThrow(/control characters/);
    expect(() => write('a\u0000b')).toThrow(/control characters/);
    expect(() => write('a\u007fb')).toThrow(/control characters/);
  });

  it('refuses free text ending in a backslash, which would join the next line', () => {
    expect(() => systemdText('Switch \\')).toThrow(/backslash/);
  });
});
