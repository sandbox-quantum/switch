import { describe, expect, it } from 'vitest';
import { basenameFromAnyPath, safePathSegment } from './path-name';

describe('path-name helpers', () => {
  describe('basenameFromAnyPath', () => {
    it('extracts a location name from a Windows path', () => {
      expect(basenameFromAnyPath('E:\\my_work\\github_pro\\switchdash')).toBe('switchdash');
    });

    it('extracts a location name from a POSIX path', () => {
      expect(basenameFromAnyPath('/home/admin/github_pro/switchdash')).toBe('switchdash');
    });

    it('ignores trailing path separators', () => {
      expect(basenameFromAnyPath('E:\\my_work\\github_pro\\switchdash\\')).toBe('switchdash');
      expect(basenameFromAnyPath('/home/admin/github_pro/switchdash/')).toBe('switchdash');
    });
  });

  describe('safePathSegment', () => {
    it('keeps normal location names unchanged', () => {
      expect(safePathSegment('switchdash')).toBe('switchdash');
    });

    it('collapses path-shaped location names to a safe single segment', () => {
      expect(safePathSegment('E:\\my_work\\github_pro\\switchdash')).toBe('switchdash');
      expect(safePathSegment('../switchdash')).toBe('switchdash');
    });

    it('falls back when no safe segment remains', () => {
      expect(safePathSegment('///', 'location-id')).toBe('location-id');
    });

    it('falls back for Windows reserved device names', () => {
      expect(safePathSegment('NUL', 'location-id')).toBe('location-id');
      expect(safePathSegment('com1', 'location-id')).toBe('location-id');
    });
  });
});
