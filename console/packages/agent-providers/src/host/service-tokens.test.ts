import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redactions } from './redaction';
import type { IssuedServiceToken, ServiceRefusal } from './service-access';
import { AgentServiceTokens, REFRESH_BEFORE_MS, REJECTION_WINDOW_MS } from './service-tokens';

const HOUR = 60 * 60_000;
const ENDPOINT = { endpoint: 'https://switch.test', token: 'agent-key', agentId: 'agent' };

function tokens(outcomes: (IssuedServiceToken | ServiceRefusal | Error)[]) {
  let now = 1_000_000;
  const issue = vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) throw new Error('no outcome left');
    if (next instanceof Error) throw next;
    return next;
  });
  const redactions = new Redactions();
  const service = new AgentServiceTokens({
    endpoint: ENDPOINT,
    redactions,
    now: () => now,
    issue,
  });
  return {
    service,
    issue,
    redactions,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentServiceTokens', () => {
  it('hands out one token until five minutes before it expires, then asks again', async () => {
    const t = tokens([]);
    const first = { token: 'synthetic-one', expiresAt: t.at() + HOUR, useUntil: t.at() + HOUR };
    const second = {
      token: 'synthetic-two',
      expiresAt: t.at() + 2 * HOUR,
      useUntil: t.at() + 2 * HOUR,
    };
    t.issue.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-one' });
    t.advance(HOUR - REFRESH_BEFORE_MS - 1);
    expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-one' });
    t.advance(2);
    expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-two' });
    expect(t.issue).toHaveBeenCalledTimes(2);
    expect(t.issue).toHaveBeenCalledWith(ENDPOINT, 'github');
    expect(t.redactions.text('synthetic-one synthetic-two')).toBe('[REDACTED] [REDACTED]');
  });

  it('asks again by use_until, an hour at most, however long the token lives', async () => {
    const t = tokens([]);
    t.issue
      .mockResolvedValueOnce({
        token: 'synthetic-day-long',
        expiresAt: t.at() + 24 * HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-day-long',
        expiresAt: t.at() + 24 * HOUR,
        useUntil: t.at() + 2 * HOUR,
      });
    await t.service.answer('example', null);
    t.advance(HOUR - REFRESH_BEFORE_MS - 1);
    await t.service.answer('example', null);
    expect(t.issue).toHaveBeenCalledTimes(1);
    t.advance(2);
    await t.service.answer('example', null);
    expect(t.issue).toHaveBeenCalledTimes(2);
  });

  it('stops handing out a token past use_until while Switch cannot be reached', async () => {
    const t = tokens([]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.issue
      .mockResolvedValueOnce({
        token: 'synthetic-day-long',
        expiresAt: t.at() + 24 * HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockRejectedValue(new Error('Switch could not be reached for an example token: offline'));
    await t.service.answer('example', null);
    t.advance(HOUR - 30_000);
    expect(await t.service.answer('example', null)).toMatchObject({
      kind: 'refused',
      code: 'unreachable',
    });
  });

  it('asks Switch once for sessions asking at the same time', async () => {
    const t = tokens([]);
    let release!: (value: IssuedServiceToken) => void;
    t.issue.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const asks = [t.service.answer('github', null), t.service.answer('github', null)];
    release({ token: 'synthetic-shared', expiresAt: t.at() + HOUR, useUntil: t.at() + HOUR });
    expect(await Promise.all(asks)).toEqual([
      expect.objectContaining({ token: 'synthetic-shared' }),
      expect.objectContaining({ token: 'synthetic-shared' }),
    ]);
    expect(t.issue).toHaveBeenCalledTimes(1);
  });

  it('replaces a token the service refused, but at most once a minute', async () => {
    const t = tokens([]);
    t.issue
      .mockResolvedValueOnce({
        token: 'synthetic-revoked',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-fresh',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-later',
        expiresAt: t.at() + 2 * HOUR,
        useUntil: t.at() + 2 * HOUR,
      });
    await t.service.answer('github', null);
    expect(await t.service.answer('github', 'synthetic-revoked')).toMatchObject({
      token: 'synthetic-fresh',
    });
    // A report about a token already replaced changes nothing.
    expect(await t.service.answer('github', 'synthetic-revoked')).toMatchObject({
      token: 'synthetic-fresh',
    });
    const again = await t.service.answer('github', 'synthetic-fresh');
    expect(again).toMatchObject({ kind: 'refused', code: 'token_rejected', final: false });
    expect(t.issue).toHaveBeenCalledTimes(2);
    t.advance(REJECTION_WINDOW_MS);
    expect(await t.service.answer('github', 'synthetic-fresh')).toMatchObject({
      token: 'synthetic-later',
    });
    expect(t.issue).toHaveBeenCalledTimes(3);
  });

  it('passes on a refusal that ends the service, and forgets the token', async () => {
    const t = tokens([]);
    t.issue
      .mockResolvedValueOnce({
        token: 'synthetic-one',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockResolvedValueOnce({
        code: 'grant_missing',
        message: 'No GitHub grant.',
        retryable: false,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-regranted',
        expiresAt: t.at() + 2 * HOUR,
        useUntil: t.at() + 2 * HOUR,
      });
    await t.service.answer('github', null);
    t.advance(HOUR - REFRESH_BEFORE_MS + 1);
    expect(await t.service.answer('github', null)).toEqual({
      kind: 'refused',
      code: 'grant_missing',
      message: 'No GitHub grant.',
      final: true,
    });
    expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-regranted' });
  });

  it('keeps handing out a token that still works while Switch cannot renew it', async () => {
    const t = tokens([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.issue
      .mockResolvedValueOnce({
        token: 'synthetic-one',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
      })
      .mockResolvedValueOnce({ code: 'internal', message: 'GitHub is down.', retryable: true })
      .mockRejectedValueOnce(new Error('Switch could not be reached for a github token: offline'));
    await t.service.answer('github', null);
    t.advance(HOUR - REFRESH_BEFORE_MS + 1);
    expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-one' });
    expect(warn.mock.calls[0]?.[0]).toContain('GitHub is down.');
    t.advance(REFRESH_BEFORE_MS - 30_000);
    expect(await t.service.answer('github', null)).toEqual({
      kind: 'refused',
      code: 'unreachable',
      message: 'Switch could not be reached for a github token: offline',
      final: false,
    });
  });
});
