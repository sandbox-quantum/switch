import { gatewayPlanFor, type VertexTokenCache } from './gateway-logins';
import type { ProviderGateway } from './provider-gateway';
import type { CredentialChange } from './reconcile';
import type { GatewayRecord } from './runtime';
import type { GivenLogin } from './sealed-logins';

/** The provider gateway and what it needs, when the controller runs one. */
export type GatewayDeps = {
  gateway: ProviderGateway;
  vertex: VertexTokenCache;
  /** Logins already said to be refused, so each is said once (`agent:provider:revision`). */
  refusedSaid?: Set<string>;
};

/**
 * What an agent's credentials file holds for its given login when the
 * controller runs a provider gateway, and whether its running host must
 * restart for it:
 *
 * - a gateway-backed login is fronted by the gateway, and the file names only
 *   the agent's opaque token (`gateway`), never the login (`fileLogin` null);
 * - a new revision of the same kind of login is swapped inside the gateway:
 *   the host's environment doesn't change, so it doesn't restart;
 * - a token saved before a controller restart is registered again, so a host
 *   that outlived the controller keeps working;
 * - a login given, or changed to another kind, gets a new token, and the host
 *   restarts for its new environment (`'login'`, which waits for a turn);
 * - a gateway-backed login withdrawn stops working at once (`'withdrawn'`);
 * - a login the gateway can't front isn't handed to the agent at all
 *   (`refused`): with the gateway on, only gateway-backed providers are
 *   offered, so no plaintext login reaches the box.
 *
 * `change` is undefined when the gateway has nothing to say: the file's own
 * comparison then decides, as without a gateway.
 */
export function resolveGateway(
  agentId: string,
  login: GivenLogin | null,
  saved: GatewayRecord | null,
  deps: GatewayDeps
): {
  fileLogin: GivenLogin | null;
  record: GatewayRecord | null;
  change?: CredentialChange;
  refused?: boolean;
} {
  const plan = login ? gatewayPlanFor(login, deps.vertex) : null;
  if (login && plan) {
    const same = saved !== null && saved.provider === login.provider && saved.kind === login.kind;
    if (same) {
      if (deps.gateway.has(agentId)) deps.gateway.update(agentId, plan.route);
      else deps.gateway.register(agentId, saved.token, plan.route);
      return { fileLogin: null, record: { ...saved, revision: login.revision }, change: false };
    }
    const token = deps.gateway.mint(agentId, plan.route);
    return {
      fileLogin: null,
      record: { token, provider: login.provider, kind: login.kind, revision: login.revision },
      change: 'login',
    };
  }
  if (saved) {
    deps.gateway.forget(agentId);
    if (!login) deps.vertex.forget(saved.provider);
    // A login it can't front is refused, so the agent is left with none.
    return {
      fileLogin: null,
      record: null,
      change: 'withdrawn',
      ...(login ? { refused: true } : {}),
    };
  }
  return login
    ? { fileLogin: null, record: null, refused: true }
    : { fileLogin: null, record: null };
}

/** The CLI environment for an agent's gateway-backed login, or null when it isn't one. */
export function gatewayEnvironment(
  login: GivenLogin,
  record: GatewayRecord | null | undefined,
  deps: GatewayDeps
): Record<string, string> | null {
  if (!record || record.provider !== login.provider || record.kind !== login.kind) return null;
  const plan = gatewayPlanFor(login, deps.vertex);
  return plan ? plan.env(deps.gateway.endpoint, record.token) : null;
}

/**
 * A short-lived gateway token, and the CLI environment carrying it, for one
 * probe of a login (the test prompt): the probe's CLI calls the provider the
 * way a real agent does, through the gateway, and never holds the login. The
 * token works for two minutes and five calls at most; call `done` when the
 * probe ends, and it stops at once. Null when the gateway can't front the login.
 */
export function gatewayProbe(
  probeId: string,
  login: GivenLogin,
  deps: GatewayDeps
): { env: Record<string, string>; done: () => void } | null {
  const plan = gatewayPlanFor(login, deps.vertex);
  if (!plan) return null;
  const token = deps.gateway.mintProbe(probeId, plan.route);
  let ended = false;
  return {
    env: plan.env(deps.gateway.endpoint, token),
    done: () => {
      if (ended) return;
      ended = true;
      deps.gateway.forgetProbe(probeId);
    },
  };
}
