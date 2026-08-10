import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { createRemoteHomePluginFs } from './remote-home-plugin-fs';

function makeCtx(exec: (command: string, args: string[]) => Promise<{ stdout: string }>) {
  const spy = vi.fn(async (command: string, args?: string[]) => ({
    ...(await exec(command, args ?? [])),
    stderr: '',
  }));
  return { ctx: { exec: spy } as unknown as IExecutionContext, exec: spy };
}

describe('createRemoteHomePluginFs', () => {
  it('sends the path and the content as positional arguments, never inline', async () => {
    const { ctx, exec } = makeCtx(async () => ({ stdout: '' }));

    await createRemoteHomePluginFs(ctx).write('.codex/hooks.json', '{"hooks":{}}');

    const [command, args] = exec.mock.calls[0]!;
    expect(command).toBe('sh');
    expect(args).toContain('.codex/hooks.json');
    expect(Buffer.from(args!.at(-1)!, 'base64').toString('utf8')).toBe('{"hooks":{}}');
    // The script itself must name neither, or a quote in either breaks out of it.
    expect(args![1]).not.toContain('.codex/hooks.json');
    expect(args![1]).not.toContain('hooks":{}');
  });

  it('decodes the file content the far side base64-encoded', async () => {
    const content = 'a = "b"\n# ünicode\n';
    const { ctx } = makeCtx(async () => ({
      stdout: `1${Buffer.from(content, 'utf8').toString('base64')}\n`,
    }));

    expect(await createRemoteHomePluginFs(ctx).read('.codex/config.toml')).toBe(content);
  });

  it('reads a missing file as null', async () => {
    const { ctx } = makeCtx(async () => ({ stdout: '0' }));

    expect(await createRemoteHomePluginFs(ctx).read('.codex/config.toml')).toBeNull();
  });

  // Hook writers read-modify-write these files. A transport failure reported as
  // "missing" makes them rewrite from scratch, discarding whatever was there —
  // for `.claude/settings.local.json`, the agent's Switch credentials.
  it('propagates a failed read instead of reporting the file as absent', async () => {
    const { ctx } = makeCtx(async () => {
      throw new Error('ssh: channel exhausted');
    });

    await expect(createRemoteHomePluginFs(ctx).read('.codex/config.toml')).rejects.toThrow(
      'channel exhausted'
    );
  });

  it('rejects an unrecognised read response rather than guessing', async () => {
    const { ctx } = makeCtx(async () => ({ stdout: '-bash: base64: command not found\n' }));

    await expect(createRemoteHomePluginFs(ctx).read('.codex/config.toml')).rejects.toThrow(
      /unreadable response/
    );
  });

  it('refuses a path that would escape the home directory', async () => {
    const { ctx, exec } = makeCtx(async () => ({ stdout: '0' }));

    await expect(createRemoteHomePluginFs(ctx).read('../../etc/passwd')).rejects.toThrow(
      /outside the home directory/
    );
    await expect(createRemoteHomePluginFs(ctx).write('/etc/passwd', 'x')).rejects.toThrow(
      /outside the home directory/
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
