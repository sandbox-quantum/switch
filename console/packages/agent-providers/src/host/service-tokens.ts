import type { Redactions } from './redaction';
import {
  endsServiceUse,
  monotonicMillis,
  type IssuedServiceToken,
  type issueServiceToken,
  type readServiceGrants,
  type ServiceEndpoint,
  type ServiceRefusal,
  type ServiceTokenAnswer,
} from './service-access';
import { redactServiceToken } from './service-credential';

/** A token is asked for again this long before it must be (`useUntil`). */
export const REFRESH_BEFORE_MS = 5 * 60_000;
/** After a rejected token is replaced, another rejection is not acted on for this long. */
export const REJECTION_WINDOW_MS = 60_000;
/** Left on a cached token for it to be handed out while Switch cannot issue another. */
const STILL_USABLE_MS = 60_000;
/** A cached token's grant is read again at most this often, when the token is asked for. */
export const GRANT_CHECK_MS = 30_000;

/** Maximum time a vendor MCP operation may start after Core begins a grant check. */
export const VERIFIED_GRANT_LEASE_MS = 30_000;

/**
 * The service tokens of one agent's sessions on this machine: one per
 * service, shared by the sessions, asked for on first use and again five
 * minutes before Switch said to stop using it (`useUntil`: its expiry, or an
 * hour after it was issued if that is sooner). Every token, and each secret
 * field of a key, is added to `redactions` as it arrives.
 *
 * A session's helper reports a token the service refused (Git erasing it,
 * `gh` told 401): it is a token Switch revoked when the grant changed, and is
 * dropped so the next ask gets one under the grant as it is now, or Switch's
 * refusal. Only one such report a minute per service is acted on, so a token
 * the service keeps refusing does not turn into a token issued per command.
 *
 * A widened grant revokes nothing, so its cached token would keep the old
 * reach until it expired. When a cached token is asked for, the agent's grants
 * are read again if they were not in the last half minute, and the token is
 * dropped once its grant has moved on or gone: the next one carries the grant
 * as it is now, or Switch's refusal.
 */
export class AgentServiceTokens {
  private readonly cached = new Map<string, IssuedServiceToken>();
  private readonly issuing = new Map<string, Promise<IssuedServiceToken | ServiceRefusal>>();
  private readonly replacedAt = new Map<string, number>();
  private readonly checkedAt = new Map<string, number>();
  private checking: Promise<Map<string, number | undefined>> | null = null;
  private readonly verified = new Map<
    string,
    {
      token: IssuedServiceToken;
      deadline: number;
      wallDeadline: number;
      wallStarted: number;
      invalid?: boolean;
    }
  >();
  private readonly verifying = new Map<string, Promise<ServiceTokenAnswer>>();
  private readonly verifiedReplacedAt = new Map<string, number>();
  private readonly verifiedGeneration = new Map<string, number>();

  constructor(
    private readonly deps: {
      endpoint: ServiceEndpoint;
      redactions: Redactions;
      now: () => number;
      monotonicNow?: () => number;
      issue: typeof issueServiceToken;
      readGrants: typeof readServiceGrants;
    }
  ) {}

  /** A verified MCP request gets no token without a recent successful Core issuance. */
  async answerVerified(service: string, rejected: string | null): Promise<ServiceTokenAnswer> {
    const clock = this.deps.monotonicNow ?? monotonicMillis;
    const cached = this.verified.get(service);
    if (rejected !== null && cached?.token.token === rejected) {
      const replaced = this.verifiedReplacedAt.get(service);
      this.verified.delete(service);
      this.verifiedGeneration.set(service, (this.verifiedGeneration.get(service) ?? 0) + 1);
      if (replaced !== undefined && clock() - replaced < REJECTION_WINDOW_MS)
        return {
          kind: 'refused',
          code: 'token_rejected',
          message: `${service} refused the replacement token. Try again later.`,
          final: false,
        };
      this.verifiedReplacedAt.set(service, clock());
    }
    const usable = this.verified.get(service);
    if (
      usable &&
      !usable.invalid &&
      clock() < usable.deadline &&
      this.deps.now() < usable.wallDeadline &&
      this.deps.now() >= usable.wallStarted
    )
      return {
        ...tokenAnswer(usable.token),
        validUntilMonotonicMs: usable.deadline,
        validUntilWallMs: usable.wallDeadline,
        validAfterWallMs: usable.wallStarted,
      };
    // Once a deadline or backwards-clock check has failed, a later clock
    // change must never revive the old grant lease.
    if (usable) usable.invalid = true;

    let pending = this.verifying.get(service);
    if (!pending) {
      const started = clock();
      const wallStarted = this.deps.now();
      const generation = this.verifiedGeneration.get(service) ?? 0;
      pending = (async (): Promise<ServiceTokenAnswer> => {
        let outcome: IssuedServiceToken | ServiceRefusal;
        try {
          // Reissue even with a revision: a removed and re-created grant can
          // have the same revision as its predecessor. Core checks its current
          // grant under the connection lock before recording the issuance.
          outcome = await this.deps.issue(this.deps.endpoint, service);
        } catch {
          return {
            kind: 'refused',
            code: 'unreachable',
            message: `Switch could not verify this agent's ${service} grant.`,
            final: false,
          };
        }
        if (!('token' in outcome))
          return {
            kind: 'refused',
            code: outcome.code,
            message: outcome.message,
            final: endsServiceUse(outcome.code),
          };
        redactServiceToken(this.deps.redactions, outcome.token);
        if ((this.verifiedGeneration.get(service) ?? 0) !== generation)
          return {
            kind: 'refused',
            code: 'token_rejected',
            message: `${service}'s token was rejected during grant validation.`,
            final: false,
          };
        const deadline = Math.min(
          started + VERIFIED_GRANT_LEASE_MS,
          clock() + Math.max(0, outcome.useUntil - this.deps.now())
        );
        const wallDeadline = Math.min(wallStarted + VERIFIED_GRANT_LEASE_MS, outcome.useUntil);
        if (clock() >= deadline || this.deps.now() >= wallDeadline || this.deps.now() < wallStarted)
          return {
            kind: 'refused',
            code: 'grant_check_expired',
            message: `Switch's ${service} grant check expired before it finished.`,
            final: false,
          };
        this.verified.set(service, { token: outcome, deadline, wallDeadline, wallStarted });
        return {
          ...tokenAnswer(outcome),
          validUntilMonotonicMs: deadline,
          validUntilWallMs: wallDeadline,
          validAfterWallMs: wallStarted,
        };
      })().finally(() => this.verifying.delete(service));
      this.verifying.set(service, pending);
    }
    const result = await pending;
    if (
      result.kind === 'token' &&
      (this.verified.get(service)?.invalid === true ||
        this.verified.get(service)?.token.token !== result.token ||
        result.validUntilMonotonicMs === undefined ||
        clock() >= result.validUntilMonotonicMs ||
        result.validUntilWallMs === undefined ||
        this.deps.now() >= result.validUntilWallMs ||
        result.validAfterWallMs === undefined ||
        this.deps.now() < result.validAfterWallMs)
    )
      return {
        kind: 'refused',
        code: 'grant_check_expired',
        message: `Switch's ${service} grant check expired before it could be used.`,
        final: false,
      };
    return result;
  }

  async answer(service: string, rejected: string | null): Promise<ServiceTokenAnswer> {
    const now = this.deps.now();
    let cached = this.cached.get(service);
    if (rejected !== null && cached?.token === rejected) {
      const replaced = this.replacedAt.get(service);
      if (replaced !== undefined && now - replaced < REJECTION_WINDOW_MS)
        return {
          kind: 'refused',
          code: 'token_rejected',
          message: `${service} refused this agent's token again within a minute of Switch issuing it, so no other is asked for until ${new Date(replaced + REJECTION_WINDOW_MS).toISOString()}. If it keeps happening, check the agent's ${service} grant in Switch.`,
          final: false,
        };
      this.replacedAt.set(service, now);
      this.cached.delete(service);
      cached = undefined;
    }
    if (cached && cached.useUntil - now > REFRESH_BEFORE_MS) {
      if (await this.grantStands(service, cached, now)) return tokenAnswer(cached);
      if (this.cached.get(service) === cached) this.cached.delete(service);
      cached = undefined;
    }

    let outcome: IssuedServiceToken | ServiceRefusal;
    try {
      outcome = await this.issue(service);
    } catch (error) {
      outcome = {
        code: 'unreachable',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if ('token' in outcome) return tokenAnswer(outcome);
    const final = endsServiceUse(outcome.code);
    if (final) this.cached.delete(service);
    else if (cached && cached.useUntil - this.deps.now() > STILL_USABLE_MS) {
      console.warn(
        `Switch could not renew this agent's ${service} token (${outcome.message}); handing out the current one, which is used until ${new Date(cached.useUntil).toISOString()}.`
      );
      return tokenAnswer(cached);
    }
    return { kind: 'refused', code: outcome.code, message: outcome.message, final };
  }

  /**
   * Whether `token`'s grant is the one it was issued under, read from Switch
   * at most every `GRANT_CHECK_MS` per service. While the grants cannot be
   * read the token stands, with a warning, as it would until it expired.
   */
  private async grantStands(
    service: string,
    token: IssuedServiceToken,
    now: number
  ): Promise<boolean> {
    if (token.grantRevision === null) return true;
    const checked = this.checkedAt.get(service);
    if (checked !== undefined && now - checked < GRANT_CHECK_MS) return true;
    let revisions: Map<string, number | undefined>;
    try {
      revisions = await this.readRevisions();
    } catch (error) {
      console.warn(
        `Switch could not be reached to check this agent's ${service} grant (${error instanceof Error ? error.message : String(error)}); handing out the current token, which expires at ${new Date(token.expiresAt).toISOString()}.`
      );
      return true;
    }
    this.checkedAt.set(service, this.deps.now());
    return revisions.get(service) === token.grantRevision;
  }

  /** One read of the grants at a time; services asking meanwhile share it. */
  private readRevisions(): Promise<Map<string, number | undefined>> {
    this.checking ??= this.deps
      .readGrants(this.deps.endpoint)
      .then((grants) => new Map(grants.map((grant) => [grant.service, grant.revision])))
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /** One request to Switch per service at a time; sessions asking meanwhile share it. */
  private issue(service: string): Promise<IssuedServiceToken | ServiceRefusal> {
    const running = this.issuing.get(service);
    if (running) return running;
    const request = this.deps
      .issue(this.deps.endpoint, service)
      .then((outcome) => {
        if ('token' in outcome) {
          redactServiceToken(this.deps.redactions, outcome.token);
          this.cached.set(service, outcome);
          this.checkedAt.set(service, this.deps.now());
        }
        return outcome;
      })
      .finally(() => this.issuing.delete(service));
    this.issuing.set(service, request);
    return request;
  }
}

function tokenAnswer(token: IssuedServiceToken): Extract<ServiceTokenAnswer, { kind: 'token' }> {
  return { kind: 'token', token: token.token, expiresAt: new Date(token.expiresAt).toISOString() };
}
