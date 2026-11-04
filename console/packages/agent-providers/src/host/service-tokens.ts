import type { Redactions } from './redaction';
import {
  endsServiceUse,
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
type GrantStatus = 'current' | 'changed' | 'unknown';

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

  constructor(
    private readonly deps: {
      endpoint: ServiceEndpoint;
      redactions: Redactions;
      now: () => number;
      issue: typeof issueServiceToken;
      readGrants: typeof readServiceGrants;
    }
  ) {}

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
      const status = await this.grantStatus(service, cached, now);
      if (status === 'current') return tokenAnswer(cached);
      if (status === 'unknown') return tokenAnswer({ ...cached, access: 'read' });
      this.cached.delete(service);
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
      const status = await this.grantStatus(service, cached, this.deps.now());
      if (status === 'changed') {
        this.cached.delete(service);
        return { kind: 'refused', code: outcome.code, message: outcome.message, final };
      }
      console.warn(
        `Switch could not renew this agent's ${service} token (${outcome.message}); handing out the current one, which is used until ${new Date(cached.useUntil).toISOString()}.`
      );
      return tokenAnswer(status === 'unknown' ? { ...cached, access: 'read' } : cached);
    }
    return { kind: 'refused', code: outcome.code, message: outcome.message, final };
  }

  /**
   * Whether `token`'s grant is the one it was issued under, read from Switch
   * at most every `GRANT_CHECK_MS` per service. If the grants cannot be read,
   * keep the token but use read-only MCP policy until Switch is reachable.
   */
  private async grantStatus(
    service: string,
    token: IssuedServiceToken,
    now: number
  ): Promise<GrantStatus> {
    if (token.grantRevision === null) return 'current';
    const checked = this.checkedAt.get(service);
    if (checked !== undefined && now - checked < GRANT_CHECK_MS) return 'current';
    let revisions: Map<string, number | undefined>;
    try {
      revisions = await this.readRevisions();
    } catch (error) {
      console.warn(
        `Switch could not be reached to check this agent's ${service} grant (${error instanceof Error ? error.message : String(error)}); handing out the current token, which expires at ${new Date(token.expiresAt).toISOString()}.`
      );
      return 'unknown';
    }
    this.checkedAt.set(service, this.deps.now());
    return revisions.get(service) === token.grantRevision ? 'current' : 'changed';
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

function tokenAnswer(token: IssuedServiceToken): ServiceTokenAnswer {
  return {
    kind: 'token',
    token: token.token,
    expiresAt: new Date(token.expiresAt).toISOString(),
    ...(token.access === undefined ? {} : { access: token.access }),
  };
}
