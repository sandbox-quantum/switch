import { afterEach, describe, expect, it, vi } from 'vitest';
import { Redactions } from './redaction';
import type { IssuedServiceToken, ServiceGrant, ServiceRefusal } from './service-access';
import {
  AgentServiceTokens,
  GRANT_CHECK_MS,
  REFRESH_BEFORE_MS,
  REJECTION_WINDOW_MS,
  VERIFIED_GRANT_LEASE_MS,
} from './service-tokens';

const HOUR = 60 * 60_000;
const ENDPOINT = { endpoint: 'https://switch.test', token: 'agent-key', agentId: 'agent' };

function grant(service: string, revision: number): ServiceGrant {
  return {
    service,
    access: 'write',
    tool_mode: 'deny',
    tools: [],
    resources: {},
    revision,
    skill: null,
    mcp_servers: [],
    cli_tools: [],
  };
}

function tokens(outcomes: (IssuedServiceToken | ServiceRefusal | Error)[]) {
  let now = 1_000_000;
  let monotonic = now;
  const issue = vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) throw new Error('no outcome left');
    if (next instanceof Error) throw next;
    return next;
  });
  const readGrants = vi.fn(async (): Promise<ServiceGrant[]> => {
    throw new Error('grants not expected');
  });
  const redactions = new Redactions();
  const service = new AgentServiceTokens({
    endpoint: ENDPOINT,
    redactions,
    now: () => now,
    monotonicNow: () => monotonic,
    issue,
    readGrants,
  });
  return {
    service,
    issue,
    readGrants,
    redactions,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
      monotonic += ms;
    },
    advanceWall: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentServiceTokens', () => {
  describe('verified vendor MCP leases', () => {
    const issued = (t: ReturnType<typeof tokens>, revision: number | null = 1) => ({
      token: 'synthetic-verified',
      expiresAt: t.at() + HOUR,
      useUntil: t.at() + HOUR,
      grantRevision: revision,
    });

    it('refuses after the lease when Core is unreachable, even when the token remains usable', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce(issued(t)).mockRejectedValue(new Error('offline'));
      expect(await t.service.answerVerified('notion', null)).toMatchObject({ kind: 'token' });
      t.advance(VERIFIED_GRANT_LEASE_MS - 1);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({ kind: 'token' });
      t.advance(1);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'refused',
        code: 'unreachable',
      });
    });

    it('expires its lease after system sleep even when monotonic time paused', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce(issued(t)).mockRejectedValue(new Error('offline'));
      await t.service.answerVerified('notion', null);
      t.advanceWall(VERIFIED_GRANT_LEASE_MS);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'refused',
        code: 'unreachable',
      });
    });

    it('refuses a cached lease if wall time moves before its grant check during sleep', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce(issued(t)).mockRejectedValue(new Error('offline'));
      await t.service.answerVerified('notion', null);
      t.advanceWall(-1000);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'refused',
        code: 'unreachable',
      });
    });

    it.each(['unreachable', 'grant_missing'])(
      'does not revive an expired lease after a clock rollback and %s',
      async (failure) => {
        const t = tokens([]);
        t.issue.mockResolvedValueOnce(issued(t));
        if (failure === 'unreachable') t.issue.mockRejectedValue(new Error('offline'));
        else
          t.issue.mockResolvedValue({
            code: 'grant_missing',
            message: 'No grant.',
            retryable: false,
          });
        await t.service.answerVerified('notion', null);
        t.advanceWall(VERIFIED_GRANT_LEASE_MS);
        expect(await t.service.answerVerified('notion', null)).toMatchObject({
          kind: 'refused',
          code: failure,
        });
        t.advanceWall(-VERIFIED_GRANT_LEASE_MS);
        expect(await t.service.answerVerified('notion', null)).toMatchObject({
          kind: 'refused',
          code: failure,
        });
      }
    );

    it('cannot detect sleep when wall time is set back inside the original lease interval', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce(issued(t));
      await t.service.answerVerified('notion', null);
      // The machine sleeps, monotonic time pauses, and wall time is moved back
      // to its pre-sleep value. Both clock readings are indistinguishable from
      // the instant just after the grant check.
      expect(await t.service.answerVerified('notion', null)).toMatchObject({ kind: 'token' });
      expect(t.issue).toHaveBeenCalledTimes(1);
    });

    it('revalidates by issuing even when the server names no revision', async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce(issued(t, null))
        .mockResolvedValueOnce({ code: 'grant_missing', message: 'No grant.', retryable: false });
      await t.service.answerVerified('notion', null);
      t.advance(VERIFIED_GRANT_LEASE_MS);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'refused',
        code: 'grant_missing',
        final: true,
      });
      expect(t.issue).toHaveBeenCalledTimes(2);
    });

    it('reissues even when a replaced grant might reuse the same revision', async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce(issued(t, 1))
        .mockResolvedValueOnce({ ...issued(t, 1), token: 'synthetic-regranted' });
      await t.service.answerVerified('notion', null);
      t.advance(VERIFIED_GRANT_LEASE_MS);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'token',
        token: 'synthetic-regranted',
      });
      expect(t.issue).toHaveBeenCalledTimes(2);
    });

    it('does not restore a token rejected while its issuance is pending', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce(issued(t));
      await t.service.answerVerified('notion', null);
      let release!: (value: IssuedServiceToken) => void;
      t.issue.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      t.advance(VERIFIED_GRANT_LEASE_MS);
      const checking = t.service.answerVerified('notion', null);
      const rejected = t.service.answerVerified('notion', 'synthetic-verified');
      release(issued(t));
      expect(await checking).toMatchObject({ kind: 'refused', code: 'token_rejected' });
      expect(await rejected).toMatchObject({ kind: 'refused', code: 'token_rejected' });
    });

    it('does not fall back to the other token cache when renewal fails', async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce(issued(t))
        .mockResolvedValueOnce(issued(t))
        .mockRejectedValue(new Error('offline'));
      await t.service.answer('notion', null);
      await t.service.answerVerified('notion', null);
      t.advance(VERIFIED_GRANT_LEASE_MS);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        kind: 'refused',
        code: 'unreachable',
      });
    });

    it('shares one concurrent check and refuses a result that arrived after its deadline', async () => {
      const t = tokens([]);
      let release!: (value: IssuedServiceToken) => void;
      t.issue.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      const requests = [
        t.service.answerVerified('notion', null),
        t.service.answerVerified('notion', null),
      ];
      expect(t.issue).toHaveBeenCalledTimes(1);
      t.advance(VERIFIED_GRANT_LEASE_MS);
      release(issued(t));
      expect(await Promise.all(requests)).toEqual([
        expect.objectContaining({ kind: 'refused', code: 'grant_check_expired' }),
        expect.objectContaining({ kind: 'refused', code: 'grant_check_expired' }),
      ]);
    });

    it('limits a lease to the token use deadline', async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce({ ...issued(t), useUntil: t.at() + 1000 })
        .mockRejectedValue(new Error('offline'));
      expect(await t.service.answerVerified('notion', null)).toMatchObject({
        validUntilMonotonicMs: t.at() + 1000,
      });
      t.advance(1000);
      expect(await t.service.answerVerified('notion', null)).toMatchObject({ kind: 'refused' });
    });
  });
  it('hands out one token until five minutes before it expires, then asks again', async () => {
    const t = tokens([]);
    const first = {
      token: 'synthetic-one',
      expiresAt: t.at() + HOUR,
      useUntil: t.at() + HOUR,
      grantRevision: null,
    };
    const second = {
      token: 'synthetic-two',
      expiresAt: t.at() + 2 * HOUR,
      useUntil: t.at() + 2 * HOUR,
      grantRevision: null,
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
        grantRevision: null,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-day-long',
        expiresAt: t.at() + 24 * HOUR,
        useUntil: t.at() + 2 * HOUR,
        grantRevision: null,
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
        grantRevision: null,
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
    release({
      token: 'synthetic-shared',
      expiresAt: t.at() + HOUR,
      useUntil: t.at() + HOUR,
      grantRevision: null,
    });
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
        grantRevision: null,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-fresh',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
        grantRevision: null,
      })
      .mockResolvedValueOnce({
        token: 'synthetic-later',
        expiresAt: t.at() + 2 * HOUR,
        useUntil: t.at() + 2 * HOUR,
        grantRevision: null,
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
        grantRevision: null,
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
        grantRevision: null,
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
        grantRevision: null,
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

  describe('a running grant change', () => {
    it('drops a token whose grant has moved on, at the next ask past half a minute', async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce({
          token: 'synthetic-read',
          expiresAt: t.at() + HOUR,
          useUntil: t.at() + HOUR,
          grantRevision: 1,
        })
        .mockResolvedValueOnce({
          token: 'synthetic-write',
          expiresAt: t.at() + HOUR,
          useUntil: t.at() + HOUR,
          grantRevision: 2,
        });
      t.readGrants.mockResolvedValue([grant('github', 2)]);
      await t.service.answer('github', null);
      t.advance(GRANT_CHECK_MS - 1);
      expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-read' });
      expect(t.readGrants).not.toHaveBeenCalled();
      t.advance(1);
      expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-write' });
      expect(t.readGrants).toHaveBeenCalledWith(ENDPOINT);
      expect(t.issue).toHaveBeenCalledTimes(2);
    });

    it('keeps a token whose grant stands, and reads the grants once for asks at the same time', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce({
        token: 'synthetic-one',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
        grantRevision: 3,
      });
      t.readGrants.mockResolvedValue([grant('github', 3)]);
      await t.service.answer('github', null);
      t.advance(GRANT_CHECK_MS);
      const answers = await Promise.all([
        t.service.answer('github', null),
        t.service.answer('github', null),
      ]);
      expect(answers).toEqual([
        expect.objectContaining({ token: 'synthetic-one' }),
        expect.objectContaining({ token: 'synthetic-one' }),
      ]);
      expect(t.readGrants).toHaveBeenCalledTimes(1);
      expect(t.issue).toHaveBeenCalledTimes(1);
    });

    it("passes on Switch's refusal once the grant is gone", async () => {
      const t = tokens([]);
      t.issue
        .mockResolvedValueOnce({
          token: 'synthetic-one',
          expiresAt: t.at() + HOUR,
          useUntil: t.at() + HOUR,
          grantRevision: 1,
        })
        .mockResolvedValueOnce({
          code: 'grant_missing',
          message: 'No GitHub grant.',
          retryable: false,
        });
      t.readGrants.mockResolvedValue([]);
      await t.service.answer('github', null);
      t.advance(GRANT_CHECK_MS);
      expect(await t.service.answer('github', null)).toMatchObject({
        kind: 'refused',
        code: 'grant_missing',
        final: true,
      });
    });

    it('keeps the token, with a warning, while the grants cannot be read', async () => {
      const t = tokens([]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      t.issue.mockResolvedValueOnce({
        token: 'synthetic-one',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
        grantRevision: 1,
      });
      t.readGrants.mockRejectedValue(new Error('offline'));
      await t.service.answer('github', null);
      t.advance(GRANT_CHECK_MS);
      expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-one' });
      expect(warn.mock.calls[0]?.[0]).toContain('offline');
      expect(t.issue).toHaveBeenCalledTimes(1);
    });

    it('never reads the grants for a token from a Switch that names no revision', async () => {
      const t = tokens([]);
      t.issue.mockResolvedValueOnce({
        token: 'synthetic-one',
        expiresAt: t.at() + HOUR,
        useUntil: t.at() + HOUR,
        grantRevision: null,
      });
      await t.service.answer('github', null);
      t.advance(10 * GRANT_CHECK_MS);
      expect(await t.service.answer('github', null)).toMatchObject({ token: 'synthetic-one' });
      expect(t.readGrants).not.toHaveBeenCalled();
    });
  });
});
