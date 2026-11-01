import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveStdioServerExecutable } from './stdio-resolver';

describe('resolveStdioServerExecutable', () => {
  const dummyVendorDir = resolve('dummy/vendor');

  it('permits system binary such as node', () => {
    const res = resolveStdioServerExecutable('node', dummyVendorDir);
    expect(res).toEqual({ executable: 'node', isScript: false });
  });

  it('permits host process.execPath runtime binary', () => {
    const res = resolveStdioServerExecutable(process.execPath, dummyVendorDir);
    expect(res).toEqual({ executable: process.execPath, isScript: false });
  });

  it('rejects shell interpreters', () => {
    expect(() => resolveStdioServerExecutable('bash', dummyVendorDir)).toThrow(
      "Direct invocation of shell interpreter 'bash' is strictly forbidden."
    );
    expect(() => resolveStdioServerExecutable('cmd.exe', dummyVendorDir)).toThrow(
      "Direct invocation of shell interpreter 'cmd.exe' is strictly forbidden."
    );
    expect(() => resolveStdioServerExecutable('powershell', dummyVendorDir)).toThrow(
      "Direct invocation of shell interpreter 'powershell' is strictly forbidden."
    );
  });

  it('rejects directory traversal attempts out of vendor dir', () => {
    expect(() =>
      resolveStdioServerExecutable('../../etc/passwd', dummyVendorDir)
    ).toThrow('attempts directory traversal outside vendor root');
  });
});
