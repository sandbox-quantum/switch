import { z } from 'zod';
import { validServiceToken } from './service-github';

/**
 * An agent's access to its owner's outside services (GitHub, later Jira and
 * Google), as Switch grants it.
 *
 * A session reads the agent's grants when it starts or resumes, through the
 * agent's own Switch endpoint: its own key, or the agents controller's relay,
 * which forwards `/agents/{id}/...` as the controller. A grant gives the
 * session its service's skill and, through the agent host, the service's
 * tokens; a change of grants reaches a session when it next starts.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,62}$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,62}$/;
const FLAG = /^(-[A-Za-z]|--[a-z0-9][a-z0-9-]{0,62})$/;

/** A vendor's command-line tool, as the catalog entry's `cli` block has it (contract §5). */
export const cliToolSchema = z.object({
  name: z.string().regex(SLUG),
  binary: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
  token_env: z.string().regex(ENV_NAME),
  config_env: z.string().regex(ENV_NAME).nullable(),
  allow: z.array(z.string().regex(COMMAND)).min(1),
  deny: z.array(z.string().refine((value) => COMMAND.test(value) || FLAG.test(value))),
  path_flags: z.record(z.string().regex(FLAG), z.enum(['read', 'write'])),
  /** Positional file arguments: the one right after `after`, wherever it stands. */
  path_args: z.array(
    z.object({
      after: z.string().regex(/^\+?[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
      direction: z.enum(['read', 'write']),
    })
  ),
  output_cap_bytes: z.number().int().min(1024),
  timeout_s: z.number().int().min(1),
  token_refused: z.object({
    exit_code: z.number().int().min(1).max(255),
    json_path: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/),
    value: z.union([z.number(), z.string()]),
  }),
  /** The pinned build, per `<platform>-<arch>` as Node names them. */
  release: z.object({
    version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/),
    targets: z.record(
      z.string().regex(/^[a-z0-9]+-[a-z0-9]+$/),
      z.object({
        url: z
          .string()
          .url()
          .refine((url) => url.startsWith('https://')),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        path: z
          .string()
          .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,3}$/),
      })
    ),
  }),
});
export type CliTool = z.infer<typeof cliToolSchema>;

export const serviceGrantSchema = z.object({
  service: z.string().regex(SLUG),
  access: z.enum(['read', 'write']),
  tool_mode: z.enum(['allow', 'deny']),
  tools: z.array(z.string()),
  resources: z.record(z.string(), z.unknown()),
  skill: z.object({ name: z.string().regex(SLUG), content: z.string() }).nullable(),
  /**
   * The vendor's MCP servers a session calls for this service, each under its
   * own name. Empty for a service whose tools are not MCP (GitHub's are git
   * and gh), and from a Switch that predates them.
   */
  mcp_servers: z
    .array(z.object({ name: z.string().regex(SLUG), url: z.string().url() }))
    .default([]),
  /**
   * The vendor's command-line tool, which this host runs for the session
   * (`vendor-cli.ts`), as Switch's catalog describes it. Empty for most
   * services, and from a Switch that predates it.
   */
  cli_tools: z.array(cliToolSchema).default([]),
});
export type ServiceGrant = z.infer<typeof serviceGrantSchema>;

const grantsResponseSchema = z.object({ grants: z.array(serviceGrantSchema) });

/** A granted service's skill: its name and its SKILL.md, frontmatter and all. */
export type ServiceSkill = { name: string; content: string };

/** Where the agent reaches Switch, and as whom. */
export type ServiceEndpoint = { endpoint: string; token: string; agentId: string };

/**
 * The agent's grants. A Switch from before service connections answers the
 * route with 404, which is the truth: it grants nothing.
 */
export async function readServiceGrants(
  switchEndpoint: ServiceEndpoint,
  fetchImpl: typeof fetch = fetch
): Promise<ServiceGrant[]> {
  const url =
    switchEndpoint.endpoint.replace(/\/$/, '') +
    `/agents/${encodeURIComponent(switchEndpoint.agentId)}/service-grants`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${switchEndpoint.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Switch could not be reached for this agent's service grants: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Switch refused this agent's service grants (HTTP ${response.status}).`);
  }
  return grantsResponseSchema.parse(await response.json()).grants;
}

/** The skills of the agent's grants, one per service. */
export function grantedSkills(grants: ServiceGrant[]): ServiceSkill[] {
  return grants.flatMap((grant) => (grant.skill ? [grant.skill] : []));
}

/** A skill as system context: its body, without the frontmatter a skills folder needs. */
export function skillContext(skill: ServiceSkill): string {
  return skill.content.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
}

/**
 * Refusals that end a session's use of a service: the grant or the owner's
 * connection is gone or changed, and asking again cannot help. Anything else
 * (Switch or the service unreachable, say) is worth asking again later.
 */
export function endsServiceUse(code: string): boolean {
  return (
    code === 'grant_missing' ||
    code === 'grant_account_changed' ||
    code === 'forbidden' ||
    code.startsWith('connector_')
  );
}

/** What a session host is answered when it asks for a service token. */
export const serviceTokenAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('token'), token: z.string().min(1), expiresAt: z.string() }),
  z.object({
    kind: z.literal('refused'),
    code: z.string(),
    message: z.string(),
    /** The refusal ends this session's use of the service (`endsServiceUse`). */
    final: z.boolean(),
  }),
]);
export type ServiceTokenAnswer = z.infer<typeof serviceTokenAnswerSchema>;

/**
 * A token as this machine holds it, both times on this machine's clock:
 * `expiresAt` when the vendor stops taking it, and `useUntil` when Switch
 * must be asked again (at most an hour after the issue, so its checks run
 * at least hourly whatever the vendor's lifetime).
 */
export type IssuedServiceToken = { token: string; expiresAt: number; useUntil: number };
export type ServiceRefusal = { code: string; message: string; retryable: boolean };

const issuedSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  // Additive in contract §5; absent from a Switch that predates them.
  expires_in: z.number().int().nonnegative().optional(),
  use_until: z.string().optional(),
});
const refusalSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
});

/**
 * Ask Switch for a token for `service`, as the agent (contract §5). Each call
 * issues one. Raises when Switch cannot be reached or answers nonsense; a
 * refusal in the contract's envelope is returned, for the caller to act on.
 */
export async function issueServiceToken(
  switchEndpoint: ServiceEndpoint,
  service: string,
  fetchImpl: typeof fetch = fetch
): Promise<IssuedServiceToken | ServiceRefusal> {
  const url =
    switchEndpoint.endpoint.replace(/\/$/, '') +
    `/agents/${encodeURIComponent(switchEndpoint.agentId)}/service-tokens/${encodeURIComponent(service)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${switchEndpoint.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `Switch could not be reached for a ${service} token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    const refusal = refusalSchema.safeParse(await response.json().catch(() => null));
    if (refusal.success) return refusal.data.error;
    return {
      code: `http_${response.status}`,
      message: `Switch refused a ${service} token (HTTP ${response.status}).`,
      retryable: response.status >= 500,
    };
  }
  const issued = issuedSchema.safeParse(await response.json().catch(() => null));
  const expiresAt = issued.success ? Date.parse(issued.data.expires_at) : Number.NaN;
  const useUntil =
    issued.success && issued.data.use_until !== undefined
      ? Date.parse(issued.data.use_until)
      : expiresAt;
  if (
    !issued.success ||
    !validServiceToken(issued.data.token) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(useUntil) ||
    useUntil > expiresAt
  )
    throw new Error(`Switch answered a ${service} token request with something that is not one.`);
  // Timed from when the answer arrived, by Switch's own count, so this
  // machine's clock is never compared with Switch's.
  const localExpiry =
    issued.data.expires_in !== undefined
      ? Date.now() + issued.data.expires_in * 1000 - 1000
      : onLocalClock(expiresAt, response);
  return {
    token: issued.data.token,
    expiresAt: localExpiry,
    useUntil: localExpiry - (expiresAt - useUntil),
  };
}

/**
 * `expiresAt`, by Switch's clock, on this machine's: how long the token has
 * left by Switch's `Date` header, counted from now. A clock an hour fast would
 * otherwise read every token as expired and fetch a new one for each command.
 * The header has whole seconds, so a second is taken off to stay early.
 */
function onLocalClock(expiresAt: number, response: Response): number {
  const serverNow = Date.parse(response.headers.get('date') ?? '');
  if (!Number.isFinite(serverNow)) return expiresAt;
  return Date.now() + (expiresAt - serverNow) - 1000;
}
