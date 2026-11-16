import { describe, expect, it } from 'vitest';
import type { AcpToolCall } from '../acp/protocol';
import {
  opencodeAcpHooks,
  opencodeCompactionProgress,
  opencodeMcpServerOf,
  parseOpencodeProviders,
} from './opencode-acp';

const list = (data: unknown[]) => JSON.stringify({ data });

describe('parseOpencodeProviders', () => {
  it('is signed in when any provider beyond the free models is connected', () => {
    const result = parseOpencodeProviders(
      list([
        { id: 'opencode', name: 'OpenCode Zen', settings: { apiKey: 'public' } },
        { id: 'anthropic', name: 'Anthropic', settings: {} },
        { id: 'github-copilot' },
      ])
    );
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('Anthropic, github-copilot');
  });
  it('says only the free models are available when nothing else is connected', () => {
    const result = parseOpencodeProviders(
      list([{ id: 'opencode', settings: { apiKey: 'public' } }])
    );
    expect(result.status).toBe('unconfigured');
    expect(result.message).toContain('free models');
  });
  it('counts an OpenCode provider with a real key as connected', () => {
    expect(
      parseOpencodeProviders(list([{ id: 'opencode', settings: { apiKey: 'sk-placeholder' } }]))
        .status
    ).toBe('authenticated');
  });
  it('fails loudly on output it cannot read', () => {
    expect(() => parseOpencodeProviders('not json')).toThrow();
    expect(() => parseOpencodeProviders('{"providers":[]}')).toThrow();
  });
});

describe('opencodeMcpServerOf', () => {
  const servers = new Set(['switch', 'git', 'github']);
  const call = (name: string) => ({ toolCallId: 'c', title: name }) as AcpToolCall;
  it('names the registered server a tool belongs to, preferring the longest match', () => {
    expect(opencodeMcpServerOf(call('switch_send_message'), servers)).toBe('switch');
    expect(opencodeMcpServerOf(call('github_create_issue'), servers)).toBe('github');
    expect(opencodeMcpServerOf(call('git_status'), servers)).toBe('git');
  });
  it('places a built-in tool on no server', () => {
    expect(opencodeMcpServerOf(call('bash'), servers)).toBeUndefined();
    expect(opencodeMcpServerOf(call('switch'), servers)).toBeUndefined();
  });
});

describe('opencodeAcpHooks permission', () => {
  const { permission } = opencodeAcpHooks([]);
  const request = {
    sessionId: 'n',
    toolCall: { toolCallId: 'c' },
    options: [
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
      { optionId: 'once', kind: 'allow_once', name: 'Once' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' },
    ],
  };
  const context = (runtimeMode: 'auto' | 'approval-required') =>
    ({ runtimeMode }) as Parameters<NonNullable<typeof permission>>[0];
  it('approves once in auto mode', async () => {
    expect(await permission!(context('auto'), request as never)).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  });
  it('leaves the ask to the person otherwise', () => {
    expect(permission!(context('approval-required'), request as never)).toBeUndefined();
  });
});

describe('opencodeCompactionProgress', () => {
  const info = (meta: unknown) => ({
    sessionUpdate: 'session_info_update',
    _meta: { 'opencode/compaction': meta },
  });

  it('reads the progress OpenCode reports in session_info_update', () => {
    expect(opencodeCompactionProgress(info({ status: 'started', reason: 'manual' }))).toEqual({
      status: 'started',
    });
    expect(opencodeCompactionProgress(info({ status: 'completed' }))).toEqual({
      status: 'completed',
    });
    expect(
      opencodeCompactionProgress(
        info({ status: 'failed', error: { type: 'compaction.failed', message: 'no template' } })
      )
    ).toEqual({ status: 'failed', message: 'no template' });
  });

  it('ignores other updates and fails on progress it cannot read', () => {
    expect(opencodeCompactionProgress({ sessionUpdate: 'session_info_update' })).toBeUndefined();
    expect(opencodeCompactionProgress({ sessionUpdate: 'agent_message_chunk' })).toBeUndefined();
    expect(opencodeCompactionProgress(info({ status: 'paused' }))).toMatchObject({
      status: 'failed',
    });
  });
});
