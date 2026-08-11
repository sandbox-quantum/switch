import { describe, expect, it } from 'vitest';
import { buildOpencodeHookBehavior, parseOpencodeHookEvent } from './hooks';

function activity(eventType: string, body: Record<string, unknown>): string | undefined {
  const parsed = parseOpencodeHookEvent(eventType, body);
  return parsed.kind === 'activity' ? parsed.detail : undefined;
}

describe('parseOpencodeHookEvent', () => {
  it('turns a tool-use into a running-tool activity line', () => {
    expect(
      activity('tool-use', { tool_name: 'edit', tool_input: { filePath: '/a/b/foo.py' } })
    ).toBe('_Running tool_ `edit` — foo.py');
  });

  it('turns a tool-done into a ran-tool activity line', () => {
    expect(
      activity('tool-done', { tool_name: 'edit', tool_input: { filePath: '/a/b/foo.py' } })
    ).toBe('_Ran tool_ `edit` — foo.py');
  });

  it('uses the command for bash', () => {
    expect(activity('tool-use', { tool_name: 'bash', tool_input: { command: 'ls -la' } })).toBe(
      '_Running tool_ `bash` — ls -la'
    );
  });

  it('collapses and truncates a long bash command', () => {
    const detail = activity('tool-use', {
      tool_name: 'bash',
      tool_input: { command: `echo ${'x'.repeat(200)}` },
    });
    expect(detail).toContain('…');
    expect(detail!.length).toBeLessThan(120);
  });

  it('uses the pattern for grep and glob', () => {
    expect(activity('tool-use', { tool_name: 'grep', tool_input: { pattern: 'TODO' } })).toBe(
      '_Running tool_ `grep` — TODO'
    );
    expect(activity('tool-use', { tool_name: 'glob', tool_input: { pattern: '**/*.ts' } })).toBe(
      '_Running tool_ `glob` — **/*.ts'
    );
  });

  it('uses the url for webfetch', () => {
    expect(
      activity('tool-use', { tool_name: 'webfetch', tool_input: { url: 'https://example.com' } })
    ).toBe('_Running tool_ `webfetch` — https://example.com');
  });

  // OpenCode keys its file tools on filePath; the other spellings are accepted
  // so an input-shape change degrades to a bare tool name rather than a wrong one.
  it.each(['filePath', 'file_path', 'path'])('reads the file path from %s', (key) => {
    expect(activity('tool-use', { tool_name: 'read', tool_input: { [key]: '/x/y/z.md' } })).toBe(
      '_Running tool_ `read` — z.md'
    );
  });

  it('keeps the line when the tool is unknown or the input is unexpected', () => {
    expect(activity('tool-use', { tool_name: 'mystery' })).toBe('_Running tool_ `mystery`');
    expect(activity('tool-use', { tool_name: 'bash', tool_input: 'not-an-object' })).toBe(
      '_Running tool_ `bash`'
    );
  });

  // A subagent spawn's activity belongs to the child, which is already updating
  // the line itself; reporting it here overwrites that with the parent's view.
  it('ignores the task tool', () => {
    expect(parseOpencodeHookEvent('tool-use', { tool_name: 'task' })).toEqual({ kind: 'ignore' });
  });

  it('ignores a tool event with no tool name', () => {
    expect(parseOpencodeHookEvent('tool-use', {})).toEqual({ kind: 'ignore' });
  });

  it('falls back to the shared parser for turn boundaries', () => {
    expect(parseOpencodeHookEvent('start', {})).toMatchObject({ kind: 'status', type: 'start' });
    expect(parseOpencodeHookEvent('stop', {})).toMatchObject({ kind: 'status', type: 'stop' });
    expect(parseOpencodeHookEvent('error', { title: 'OpenCode error' })).toMatchObject({
      kind: 'status',
      type: 'error',
    });
  });

  it('falls back to the shared parser for the session id', () => {
    expect(parseOpencodeHookEvent('session', { sessionId: 'ses_abc' })).toEqual({
      kind: 'session',
      providerSessionId: 'ses_abc',
    });
  });
});

describe('buildOpencodeHookBehavior', () => {
  // OpenCode's hooks ride a dropped plugin file, so the config methods are
  // never called for it. They exist to satisfy the interface, and must stay
  // inert rather than write a hook config no OpenCode session would read.
  it('writes no hook config', async () => {
    const behavior = buildOpencodeHookBehavior();
    const fs = {} as never;
    expect(await behavior.readHooks(fs)).toEqual([]);
    expect(await behavior.writeHooks(fs, [])).toEqual([]);
    expect(await behavior.getHooksInstalled(fs)).toBe(false);
    await expect(behavior.deleteHooks(fs)).resolves.toBeUndefined();
  });

  it('supplies the opencode parser', () => {
    expect(buildOpencodeHookBehavior().parseHookEvent).toBe(parseOpencodeHookEvent);
  });
});
