import { describe, expect, it, vi } from 'vitest';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { writeRemoteSwitchSettings } from './write-remote-switch-settings';
import { mergeSwitchSettings } from './write-switch-settings';

const CREDS = {
  apiEndpoint: 'https://switch.example.com',
  agentId: 'agent-123',
};

describe('mergeSwitchSettings', () => {
  it('produces the SWITCH_* env block and connector allow rules from scratch', () => {
    const merged = JSON.parse(mergeSwitchSettings(null, CREDS)) as Record<string, unknown>;
    // No token: it goes to the home-side store, not into a working tree.
    expect(merged.env).toEqual({
      SWITCH_API_ENDPOINT: 'https://switch.example.com',
      SWITCH_AGENT_ID: 'agent-123',
    });
    expect((merged.permissions as { allow: string[] }).allow).toContain(
      'mcp__plugin_switch-connector_switch'
    );
  });

  it('merges into an existing file, preserving unrelated keys and env entries', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash'] },
      env: { EXISTING_KEY: 'keep-me', SWITCH_API_TOKEN: 'old' },
      somethingElse: 1,
    });
    const merged = JSON.parse(mergeSwitchSettings(existing, CREDS)) as Record<string, unknown>;
    expect(merged.somethingElse).toBe(1);
    expect(merged.env).toMatchObject({ EXISTING_KEY: 'keep-me' });
    // A token left over from before the split is removed, not carried forward.
    expect(merged.env).not.toHaveProperty('SWITCH_API_TOKEN');
    expect((merged.permissions as { allow: string[] }).allow).toContain('Bash');
  });

  it('replaces a malformed file wholesale rather than half-merging', () => {
    const merged = JSON.parse(mergeSwitchSettings('not json {', CREDS)) as Record<string, unknown>;
    expect(merged.env).toMatchObject({ SWITCH_AGENT_ID: 'agent-123' });
  });
});

function fakeFs(existing: string | null): {
  fs: FileSystemProvider;
  writes: Array<{ path: string; content: string }>;
  mkdirs: string[];
} {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  const fs = {
    read: vi.fn(async (_path: string) => {
      if (existing === null) {
        throw new FileSystemError('no such file', FileSystemErrorCodes.NOT_FOUND);
      }
      return { content: existing, truncated: false, totalSize: existing.length };
    }),
    mkdir: vi.fn(async (dirPath: string) => {
      mkdirs.push(dirPath);
    }),
    write: vi.fn(async (filePath: string, content: string) => {
      writes.push({ path: filePath, content });
      return { success: true, bytesWritten: content.length };
    }),
  } as unknown as FileSystemProvider;
  return { fs, writes, mkdirs };
}

describe('writeRemoteSwitchSettings', () => {
  it('creates .claude and writes the merged settings over the remote fs', async () => {
    const { fs, writes, mkdirs } = fakeFs(null);
    await writeRemoteSwitchSettings(fs, CREDS);

    expect(mkdirs).toContain('.claude');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('.claude/settings.local.json');
    const parsed = JSON.parse(writes[0]!.content) as { env: Record<string, string> };
    expect(parsed.env.SWITCH_AGENT_ID).toBe('agent-123');
    // Nothing secret crosses to the remote working tree; the token is written
    // separately, to that host's `$HOME` at 0600.
    expect(writes[0]!.content).not.toContain('secret-token');
  });

  it('fails loud when the remote write is rejected', async () => {
    const fs = {
      read: vi.fn(async () => {
        throw new FileSystemError('no such file', FileSystemErrorCodes.NOT_FOUND);
      }),
      mkdir: vi.fn(async () => {}),
      write: vi.fn(async () => ({ success: false, bytesWritten: 0, error: 'permission denied' })),
    } as unknown as FileSystemProvider;

    await expect(writeRemoteSwitchSettings(fs, CREDS)).rejects.toThrow(/permission denied/);
  });

  it('propagates a transport read failure instead of rewriting the file from scratch', async () => {
    const write = vi.fn(async () => ({ success: true, bytesWritten: 0 }));
    const fs = {
      read: vi.fn(async () => {
        throw new FileSystemError('channel open failure', FileSystemErrorCodes.CONNECTION_ERROR);
      }),
      mkdir: vi.fn(async () => {}),
      write,
    } as unknown as FileSystemProvider;

    await expect(writeRemoteSwitchSettings(fs, CREDS)).rejects.toThrow(/channel open failure/);
    expect(write).not.toHaveBeenCalled();
  });
});
