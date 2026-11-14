import { describe, expect, it } from 'vitest';
import { OpencodeUnsupportedVersionError, opencodeLineOf, parseOpencodeVersion } from './version';

describe('parseOpencodeVersion', () => {
  it('reads the version however the CLI prints it', () => {
    expect(parseOpencodeVersion('1.19.5\n')).toBe('1.19.5');
    expect(parseOpencodeVersion('opencode v2.3.0')).toBe('2.3.0');
    expect(parseOpencodeVersion('warning: x\n2.10.1-beta.2')).toBe('2.10.1');
  });
  it('finds nothing in output without a version', () => {
    expect(parseOpencodeVersion('command not found')).toBeNull();
    expect(parseOpencodeVersion('build 1.2')).toBeNull();
  });
});

describe('opencodeLineOf', () => {
  it('drives 1.x over HTTP and 2.x over ACP', () => {
    expect(opencodeLineOf('0.15.0')).toBe(1);
    expect(opencodeLineOf('1.19.5')).toBe(1);
    expect(opencodeLineOf('2.0.0')).toBe(2);
    expect(opencodeLineOf('2.99.1')).toBe(2);
  });
  it('refuses a major this build does not know', () => {
    expect(() => opencodeLineOf('3.0.0')).toThrow(OpencodeUnsupportedVersionError);
    expect(() => opencodeLineOf('3.0.0')).toThrow(/npm install -g @opencode\/cli@2/);
  });
});
