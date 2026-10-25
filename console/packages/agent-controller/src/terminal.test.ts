import { describe, expect, it } from 'vitest';
import {
  createColors,
  formatKeyValue,
  formatProcessStatus,
  formatSection,
  formatTable,
  isColorSupported,
  reasonFix,
  stripAnsi,
  visibleLength,
} from './terminal';

describe('terminal color detection', () => {
  it('respects NO_COLOR environment variable regardless of TTY', () => {
    const originalNoColor = process.env.NO_COLOR;
    const originalForceColor = process.env.FORCE_COLOR;
    try {
      process.env.NO_COLOR = '1';
      delete process.env.FORCE_COLOR;
      expect(isColorSupported({ isTTY: true } as NodeJS.WriteStream)).toBe(false);
      process.env.NO_COLOR = '';
      expect(isColorSupported({ isTTY: true } as NodeJS.WriteStream)).toBe(false);
    } finally {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = originalForceColor;
    }
  });

  it('respects NODE_DISABLE_COLORS=1', () => {
    const originalDisable = process.env.NODE_DISABLE_COLORS;
    const originalNoColor = process.env.NO_COLOR;
    try {
      delete process.env.NO_COLOR;
      process.env.NODE_DISABLE_COLORS = '1';
      expect(isColorSupported({ isTTY: true } as NodeJS.WriteStream)).toBe(false);
    } finally {
      if (originalDisable === undefined) delete process.env.NODE_DISABLE_COLORS;
      else process.env.NODE_DISABLE_COLORS = originalDisable;
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    }
  });

  it('honors FORCE_COLOR=1 even when stream is not a TTY', () => {
    const originalForceColor = process.env.FORCE_COLOR;
    const originalNoColor = process.env.NO_COLOR;
    try {
      delete process.env.NO_COLOR;
      process.env.FORCE_COLOR = '1';
      expect(isColorSupported({ isTTY: false } as NodeJS.WriteStream)).toBe(true);
    } finally {
      if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = originalForceColor;
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    }
  });

  it('returns stream.isTTY when no environment overrides are set', () => {
    const originalForceColor = process.env.FORCE_COLOR;
    const originalNoColor = process.env.NO_COLOR;
    const originalDisable = process.env.NODE_DISABLE_COLORS;
    try {
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
      delete process.env.NODE_DISABLE_COLORS;
      expect(isColorSupported({ isTTY: true } as NodeJS.WriteStream)).toBe(true);
      expect(isColorSupported({ isTTY: false } as NodeJS.WriteStream)).toBe(false);
      expect(isColorSupported({} as NodeJS.WriteStream)).toBe(false);
    } finally {
      if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = originalForceColor;
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
      if (originalDisable === undefined) delete process.env.NODE_DISABLE_COLORS;
      else process.env.NODE_DISABLE_COLORS = originalDisable;
    }
  });
});

describe('ANSI stripping and visible length', () => {
  it('strips escape codes and calculates visible length accurately', () => {
    const colors = createColors(true);
    const text = colors.green('✔ ok');
    expect(text).toContain('\x1b[32m');
    expect(stripAnsi(text)).toBe('✔ ok');
    expect(visibleLength(text)).toBe(4);
  });
});

describe('formatTable', () => {
  it('aligns columns cleanly for plain text', () => {
    const headers = ['NAME', 'ID', 'STATUS'];
    const rows = [
      ['Claude Worker', 'agent-1', 'running'],
      ['Helper', 'agent-2', 'failed'],
    ];
    const table = formatTable(headers, rows, { color: false });
    const lines = table.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('NAME           ID       STATUS ');
    expect(lines[1]).toBe('Claude Worker  agent-1  running');
    expect(lines[2]).toBe('Helper         agent-2  failed ');
  });

  it('aligns columns with ANSI colors based on visible width', () => {
    const headers = ['NAME', 'STATUS'];
    const colors = createColors(true);
    const rows = [
      ['Claude Worker', colors.green('✔ running')],
      ['Helper', colors.red('✖ failed')],
    ];
    const table = formatTable(headers, rows, { color: true });
    const plainLines = stripAnsi(table).split('\n');
    expect(plainLines[0]).toBe('NAME           STATUS   ');
    expect(plainLines[1]).toBe('Claude Worker  ✔ running');
    expect(plainLines[2]).toBe('Helper         ✖ failed ');
  });

  it('respects custom indent', () => {
    const table = formatTable(['A'], [['1']], { indent: '  ', color: false });
    expect(table).toBe('  A\n  1');
  });
});

describe('formatKeyValue', () => {
  it('aligns labels and omits empty/null values', () => {
    const result = formatKeyValue(
      [
        ['Controller ID', 'controller-1'],
        ['Name', 'build-box'],
        ['Empty', ''],
        ['Null', null],
        ['Data directory', '/data'],
      ],
      { indent: '  ', color: false }
    );
    expect(result).toBe(
      '  Controller ID:   controller-1\n  Name:            build-box\n  Data directory:  /data'
    );
  });
});

describe('formatProcessStatus', () => {
  it('returns plain status string when color is disabled', () => {
    expect(formatProcessStatus('running', false)).toBe('running');
    expect(formatProcessStatus('failed', false)).toBe('failed');
    expect(formatProcessStatus('stopped', false)).toBe('stopped');
  });

  it('adds colored marks when color is enabled', () => {
    const running = formatProcessStatus('running', true);
    expect(stripAnsi(running)).toBe('✔ running');
    expect(running).toContain('\x1b[32m');

    const failed = formatProcessStatus('failed', true);
    expect(stripAnsi(failed)).toBe('✖ failed');
    expect(failed).toContain('\x1b[31m');
  });
});

describe('formatSection', () => {
  it('formats title with color or plain', () => {
    expect(formatSection('AGENTS', { color: false })).toBe('AGENTS');
    const colored = formatSection('AGENTS', { color: true });
    expect(stripAnsi(colored)).toBe('AGENTS');
    expect(colored).toContain('\x1b[1m');
  });
});

describe('reasonFix', () => {
  it('maps known reason codes to actionable remediation advice', () => {
    expect(reasonFix('provider_not_installed')).toMatch(/Install the provider CLI/);
    expect(reasonFix('provider_login_missing')).toMatch(/Sign in with the provider CLI/);
    expect(reasonFix('invalid_credential')).toMatch(/Re-enroll the machine/);
    expect(reasonFix('controller_revoked')).toMatch(/Re-enroll this machine/);
    expect(reasonFix('unknown_reason_code')).toBeNull();
  });

  it('detects credential failure details', () => {
    expect(reasonFix('internal', 'The relay rejected the agent credentials')).toMatch(
      /rejected by the relay/
    );
  });
});
