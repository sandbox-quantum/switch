import { describe, expect, it } from 'vitest';
import {
  clearDraggedLocationFile,
  getDraggedLocationFile,
  hasDraggedLocationFile,
  resolveLocationFileTargetPath,
  setDraggedLocationFile,
} from '@renderer/lib/drag-files';

function makeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    types: [] as string[],
    files: [] as unknown as FileList,
    effectAllowed: 'all',
    setData(type: string, value: string) {
      if (!values.has(type)) this.types.push(type);
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  return transfer as unknown as DataTransfer;
}

describe('drag-files', () => {
  it('resolves location-relative paths into the location target path', () => {
    expect(resolveLocationFileTargetPath('/tmp/repo/', 'src/file name.ts')).toBe(
      '/tmp/repo/src/file name.ts'
    );
    expect(resolveLocationFileTargetPath('C:\\repo\\', 'src/file name.ts')).toBe(
      'C:\\repo\\src\\file name.ts'
    );
  });

  it('carries location file payloads for same-window drops', () => {
    const dataTransfer = makeDataTransfer();

    setDraggedLocationFile(dataTransfer, {
      locationId: 'location-1',
      locationRootPath: '/remote/repo',
      relPath: 'src/index.ts',
      targetPlatform: 'linux',
    });

    expect(hasDraggedLocationFile(dataTransfer)).toBe(true);
    expect(getDraggedLocationFile(dataTransfer)).toEqual({
      locationId: 'location-1',
      relPath: 'src/index.ts',
      targetPath: '/remote/repo/src/index.ts',
      targetPlatform: 'linux',
    });
    expect(dataTransfer.getData('text/plain')).toBe('/remote/repo/src/index.ts');
  });

  it('does not accept stale location state without a matching transfer marker', () => {
    const sourceTransfer = makeDataTransfer();
    setDraggedLocationFile(sourceTransfer, {
      locationId: 'location-1',
      locationRootPath: '/repo',
      relPath: 'src/index.ts',
    });

    const unrelatedTransfer = makeDataTransfer();

    expect(hasDraggedLocationFile(unrelatedTransfer)).toBe(false);
    expect(getDraggedLocationFile(unrelatedTransfer)).toBeNull();
    clearDraggedLocationFile();
  });

  it('falls back to the serialized transfer payload after dragend clears same-window state', () => {
    const dataTransfer = makeDataTransfer();
    setDraggedLocationFile(dataTransfer, {
      locationId: 'location-1',
      locationRootPath: '/repo',
      relPath: 'src/index.ts',
    });
    clearDraggedLocationFile();

    expect(getDraggedLocationFile(dataTransfer)).toEqual({
      locationId: 'location-1',
      relPath: 'src/index.ts',
      targetPath: '/repo/src/index.ts',
    });
  });
});
