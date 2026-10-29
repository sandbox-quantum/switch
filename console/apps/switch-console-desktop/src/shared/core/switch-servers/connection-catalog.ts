import { z } from 'zod';

/** One value a person pastes (a key: secret) or picks (a site, among `choices`) to connect. */
export const serviceKeyFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  secret: z.boolean(),
  help: z.string().nullable(),
  choices: z.array(z.string()).nullable(),
});
export type ServiceKeyField = z.infer<typeof serviceKeyFieldSchema>;

/** What a person pastes to connect a service connected with a key, and where they make one. */
export const serviceKeyFormSchema = z.object({
  fields: z.array(serviceKeyFieldSchema).min(1),
  help_url: z.string().nullable(),
});
export type ServiceKeyForm = z.infer<typeof serviceKeyFormSchema>;

/**
 * Why a service can't be used on the server, for the screens to say what
 * each person can do about it (`UnavailableCode` in Core's
 * `connections/broker.py`):
 * - `coming_soon`: not built yet.
 * - `switched_off`: the server's operator switched it off in its settings.
 * - `needs_https`: it can't work on this server: GitHub's App needs the
 *   server's address to be https, or loopback http (localhost, 127.0.0.1 or
 *   ::1), and it is plain http to another host.
 * - `needs_public_url`: its sign-ins return only to the server, which has no
 *   public address (`GATEWAY_PUBLIC_URL`).
 * - `app_not_set_up`: its app is the operator's to set up, under Admin →
 *   Connector apps, and isn't yet.
 * - `not_set_up`: nothing on this server connects it.
 * - `not_fully_set_up`: it can be connected but not granted to agents.
 * - `key_never_expires`: it connects with a key that never expires, which
 *   Switch does not hand to agents, so there is nothing to connect it for.
 */
export const UNAVAILABLE_CODES = [
  'coming_soon',
  'switched_off',
  'needs_https',
  'needs_public_url',
  'app_not_set_up',
  'not_set_up',
  'not_fully_set_up',
  'key_never_expires',
] as const;
export type UnavailableCode = (typeof UNAVAILABLE_CODES)[number];

/**
 * A code as the screens act on it: null for none, and for one a newer server
 * sends that this Console doesn't know, whose reason is then shown as it is.
 */
export function knownUnavailableCode(code: string | null): UnavailableCode | null {
  return UNAVAILABLE_CODES.find((known) => known === code) ?? null;
}

export const connectionCatalogEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  auth_type: z.enum(['oauth', 'api_key']),
  /** Whether it can be connected on this server: there is something to connect it to. */
  connectable: z.boolean(),
  status: z.enum(['connected', 'not_connected', 'needs_reauthorization', 'coming_soon']),
  /** Why the service cannot be granted to agents on this server; null when it can. */
  unavailable_reason: z.string().nullable(),
  /**
   * The same, as a code to act on. Null when it can be granted, and from a
   * server that predates the codes, where only the reason is shown.
   */
  unavailable_code: z.enum(UNAVAILABLE_CODES).nullable(),
  /**
   * Whether a grant hands the agent the owner's own token: on or off, at the
   * connection's level. False for GitHub, whose grant names repositories.
   */
  pass_through: z.boolean(),
  /** The longest a token handed out lives, in seconds; null when the catalog does not say. */
  token_lifetime: z.number().nullable(),
  /**
   * The only ports this Console's listener may take a sign-in back on, for a
   * vendor that matches the port registered; null for any port.
   */
  loopback_ports: z.array(z.number().int()).nullable(),
  /** The fields a person pastes to connect it, for a service connected with a key; else null. */
  key: serviceKeyFormSchema.nullable(),
  /** The connected account as people recognise it; null when not connected. */
  external_identity: z.string().nullable(),
  /** What the person allowed when they connected; null when not connected or not said. */
  consent: z.enum(['read', 'write']).nullable(),
  /**
   * Whether the workspace has the service switched on. Null from a server
   * with no workspace switch, which every page treats as on.
   */
  workspace_enabled: z.boolean().nullable(),
});
export type ConnectionCatalogEntry = z.infer<typeof connectionCatalogEntrySchema>;

/** `GET /provider-connections/catalog`, which servers before service connections answer. */
export const connectionCatalogSchema = z.object({
  connections: z.array(
    connectionCatalogEntrySchema
      .omit({
        status: true,
        connectable: true,
        unavailable_reason: true,
        unavailable_code: true,
        pass_through: true,
        token_lifetime: true,
        loopback_ports: true,
        key: true,
        external_identity: true,
        consent: true,
        workspace_enabled: true,
      })
      .extend({ status: z.enum(['connected', 'not_connected', 'coming_soon']) })
  ),
});

/** `GET /service-connections`: every catalog service, with the person's connection to it. */
export const serviceConnectionsSchema = z.object({
  connections: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      category: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      auth_type: z.enum(['oauth', 'api_key']),
      connectable: z.boolean(),
      unavailable_reason: z.string().nullable(),
      // Absent from a Switch that predates them.
      unavailable_code: z.string().nullable().default(null),
      pass_through: z.boolean().default(false),
      token_lifetime: z.number().nullable().default(null),
      loopback_ports: z.array(z.number().int()).nullable().default(null),
      key: serviceKeyFormSchema.nullable().default(null),
      external_identity: z.string().nullable().default(null),
      consent: z.enum(['read', 'write']).nullable().default(null),
      workspace_enabled: z.boolean().nullable().default(null),
      status: z.enum(['not_connected', 'active', 'needs_reauthorization']),
    })
  ),
});

/** `GET /service-connections/{service}/agents`: the person's own agents in the workspace. */
export const connectionAgentsSchema = z.array(
  z.object({
    agent_id: z.string(),
    name: z.string(),
    /** Whether the agent has a grant on the service. */
    granted: z.boolean(),
    /** Whether anyone but its owner can address it, and so use what it is granted. */
    addressing_open: z.boolean(),
  })
);
export type ConnectionAgent = z.infer<typeof connectionAgentsSchema>[number];

/** One catalog service as a workspace admin sees it: switched on or off, and who it reaches. */
export const workspaceServiceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** Who last switched it; null while nobody has touched its switch. */
  updated_by_name: z.string().nullable(),
  updated_at: z.string().nullable(),
  /** How many people in the workspace have connected it. */
  connected_members: z.number().int(),
  /** How many agents in the workspace are granted it. */
  granted_agents: z.number().int(),
});
export type WorkspaceService = z.infer<typeof workspaceServiceSchema>;

/** `GET /workspace/services`, for workspace admins. */
export const workspaceServicesSchema = z.object({ services: z.array(workspaceServiceSchema) });

/** `PUT /workspace/services/{service}`: `warning` when issued access could not all be revoked yet. */
export const workspaceServiceChangeSchema = z.object({
  slug: z.string(),
  enabled: z.boolean(),
  warning: z.string().nullable(),
});
export type WorkspaceServiceChange = z.infer<typeof workspaceServiceChangeSchema>;
