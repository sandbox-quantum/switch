
import { describe, expect, it } from 'vitest';
import {
  colorize,
  formatKeyValueRows,
  formatSection,
  formatStatusMark,
  supportsColor,
} from './format';

describe('CLI formatting', () => {
  describe('supportsColor', () => {
    it('enables color for an interactive terminal', () => {
      expect(supportsColor({ isTTY: true }, {})).toBe(true);
    });

    it('disables color when output is piped', () => {
      expect(supportsColor({ isTTY: false }, {})).toBe(false);
    });

    it('disables color when NO_COLOR is set', () => {
      expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    });
  });

  describe('colorize', () => {
    it('adds ANSI color when enabled', () => {
      expect(colorize('Success', 'green', true)).toBe(
        '\u001b[32mSuccess\u001b[0m'
      );
    });

    it('returns plain text when disabled', () => {
      expect(colorize('Success', 'green', false)).toBe('Success');
    });
  });

  describe('formatStatusMark', () => {
    it('formats all status labels consistently', () => {
      expect(formatStatusMark('ok', false)).toBe('OK');
      expect(formatStatusMark('warn', false)).toBe('WARN');
      expect(formatStatusMark('fail', false)).toBe('FAIL');
    });
  });

  describe('formatKeyValueRows', () => {
    it('aligns labels into columns', () => {
      expect(
        formatKeyValueRows([
          { label: 'OS', value: 'Windows' },
          { label: 'Architecture', value: 'x64' },
        ])
      ).toBe('OS            Windows\nArchitecture  x64');
    });

    it('supports indentation', () => {
      expect(
        formatKeyValueRows([{ label: 'Status', value: 'Running' }], '  ')
      ).toBe('  Status  Running');
    });

    it('handles empty rows', () => {
      expect(formatKeyValueRows([])).toBe('');
    });
  });

  describe('formatSection', () => {
    it('formats a titled section', () => {
      expect(formatSection('Machine', ['OS: Windows', 'Arch: x64'])).toBe(
        'Machine\n  OS: Windows\n  Arch: x64'
      );
    });
  });
});
