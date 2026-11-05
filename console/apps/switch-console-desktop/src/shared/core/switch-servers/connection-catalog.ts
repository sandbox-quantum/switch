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

/** The credentials a service that signs in may take pasted in its place. */
export const PASTE_METHODS = ['token', 'keys'] as const;
export type PasteMethodName = (typeof PASTE_METHODS)[number];

/**
 * A credential a person may paste in place of signing in: what they paste,
 * where they make one, and who ends it. What they pick (a site) is the
 * sign-in's own `sign_in_choices`.
 */
export const servicePasteMethodSchema = z.object({
  method: z.enum(PASTE_METHODS),
  label: z.string(),
  fields: z.array(serviceKeyFieldSchema).min(1),
  help_url: z.string().nullable(),
  /** `vendor`: it ends on the date it was made to end; `never`: only the vendor can revoke it. */
  expires: z.enum(['vendor', 'never']),
  /** What a connection made with it reaches, said in place of an access level. */
  access_note: z.string(),
});
export type ServicePasteMethod = z.infer<typeof servicePasteMethodSchema>;

/** A paste method as a server sends it, a newer one's method or expiry included. */
const servicePasteWireSchema = servicePasteMethodSchema.extend({
  method: z.string(),
  expires: z.string(),
});

/**
 * The paste methods this Console can offer: a newer server's method or
 * expiry it does not know is left out, so it is never offered half-understood.
 */
export function knownPasteMethods(
  offered: z.infer<typeof servicePasteWireSchema>[]
): ServicePasteMethod[] {
  return offered.flatMap((method) => {
    const known = servicePasteMethodSchema.safeParse(method);
    return known.success ? [known.data] : [];
  });
}

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
   * Why it can be granted for reading only on the server (its GitHub App
   * lacks the write permissions), for a form to say beside the write choice
   * it disables. Null where writing can be granted too, and from a server
   * that predates it.
   */
  read_only_reason: z.string().nullable(),
  /**
   * Whether a grant hands the agent the owner's own token: on or off, at the
   * connection's level. False for GitHub, whose grant names repositories.
   */
  pass_through: z.boolean(),
  /** The longest a token handed out lives, in seconds; null when the catalog does not say. */
  token_lifetime: z.number().nullable(),
  /**
   * What limits agent access beyond that lifetime, for people to read (Sentry:
   * agents have it for up to an hour after each sign-in); null for most services.
   */
  agent_access_note: z.string().nullable(),
  /**
   * The only ports this Console's listener may take a sign-in back on, for a
   * vendor that matches the port registered; null for any port.
   */
  loopback_ports: z.array(z.number().int()).nullable(),
  /**
   * The path this Console's listener takes a sign-in back on, in place of
   * `SERVICE_CALLBACK_PATH`, for a vendor that insists on its own; null for
   * the default.
   */
  loopback_callback_path: z.string().nullable(),
  /** The fields a person pastes to connect it, for a service connected with a key; else null. */
  key: serviceKeyFormSchema.nullable(),
  /**
   * What a person picks before signing in (a vendor's site), each from its
   * list, for a service whose sign-in asks; else null.
   */
  sign_in_choices: z.array(serviceKeyFieldSchema).nullable(),
  /**
   * What a person may paste in place of signing in (a token, or keys), each
   * with its fields; empty where the service takes none on this server.
   */
  paste: z.array(servicePasteMethodSchema),
  /** The connected account as people recognise it; null when not connected. */
  external_identity: z.string().nullable(),
  /**
   * How the person connected: `oauth` (a sign-in), `token` (a pasted token)
   * or `keys` (pasted keys). Null when not connected, or not said.
   */
  method: z.string().nullable(),
  /** What a pasted connection reaches, said in place of its level; null for any other. */
  access_note: z.string().nullable(),
  /**
   * Why the connection must be reconnected, as a code to act on and the
   * sentence to show, where its status says it must; null otherwise and from
   * a server that predates them. `token_refused` asks for a new pasted
   * credential, made the way the connection was.
   */
  reconnect_code: z.string().nullable(),
  reconnect_reason: z.string().nullable(),
  /** What the person picked to connect (a site), by name; null when not connected. */
  choices: z.record(z.string(), z.string()).nullable(),
  /** What the person allowed when they connected; null when not connected or not said. */
  consent: z.enum(['read', 'write']).nullable(),
  /**
   * Whether the workspace has the service switched on. Null from a server
   * with no workspace switch, which every page treats as on.
   */
  workspace_enabled: z.boolean().nullable(),
  /**
   * Whether the workspace's organization locked `workspace_enabled`, out of
   * the workspace admin's reach. False from a server without the lock.
   */
  organization_locked: z.boolean(),
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
        read_only_reason: true,
        pass_through: true,
        token_lifetime: true,
        agent_access_note: true,
        loopback_ports: true,
        loopback_callback_path: true,
        key: true,
        sign_in_choices: true,
        paste: true,
        external_identity: true,
        method: true,
        access_note: true,
        reconnect_code: true,
        reconnect_reason: true,
        choices: true,
        consent: true,
        workspace_enabled: true,
        organization_locked: true,
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
      read_only_reason: z.string().nullable().default(null),
      pass_through: z.boolean().default(false),
      token_lifetime: z.number().nullable().default(null),
      agent_access_note: z.string().nullable().default(null),
      loopback_ports: z.array(z.number().int()).nullable().default(null),
      // Absent from a Switch that predates it.
      loopback_callback_path: z.string().nullable().default(null),
      key: serviceKeyFormSchema.nullable().default(null),
      /** What a person picks before signing in (a vendor's site); null when nothing. */
      sign_in_choices: z.array(serviceKeyFieldSchema).nullable().default(null),
      /** What a person may paste in place of signing in; empty when nothing. */
      paste: z.array(servicePasteWireSchema).default([]),
      external_identity: z.string().nullable().default(null),
      consent: z.enum(['read', 'write']).nullable().default(null),
      workspace_enabled: z.boolean().nullable().default(null),
      organization_locked: z.boolean().default(false),
      /**
       * How the person connected: `oauth` (a sign-in), `token` (a pasted
       * token) or `keys` (pasted keys). Null when not connected.
       */
      method: z.string().nullable().default(null),
      /**
       * What the person picked from the service's lists to connect (a site),
       * by name. Null when not connected.
       */
      choices: z.record(z.string(), z.string()).nullable().default(null),
      /** What a pasted connection reaches; null for any other. */
      access_note: z.string().nullable().default(null),
      /** Why the connection must be reconnected, where its status says so. */
      reconnect_code: z.string().nullable().default(null),
      reconnect_reason: z.string().nullable().default(null),
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
    /**
     * The grant was made for another account than the one connected now, so it
     * gives no access. An older server leaves it out.
     */
    account_changed: z.boolean().optional(),
    /** Whether anyone but its owner can address it, and so use what it is granted. */
    addressing_open: z.boolean(),
  })
);
export type ConnectionAgent = z.infer<typeof connectionAgentsSchema>[number];

/** One catalog service as the workspace's settings show it: switched on or off, and, for an admin, who it reaches. */
export const workspaceServiceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** Who last switched it; null while nobody has touched its switch. */
  updated_by_name: z.string().nullable(),
  updated_at: z.string().nullable(),
  /** How many people in the workspace have connected it; null for anyone but an admin. */
  connected_members: z.number().int().nullable(),
  /** How many agents in the workspace are granted it; null for anyone but an admin. */
  granted_agents: z.number().int().nullable(),
  /**
   * Why nobody in the workspace can use it, whatever its switch says; null
   * when they can, and from a server that predates them.
   */
  unavailable_code: z.string().nullable().default(null),
  unavailable_reason: z.string().nullable().default(null),
  /** Whether the caller may switch it: an admin, on a service the organization has not locked. */
  can_change: z.boolean().default(true),
  /** Whether the workspace's organization locked it, out of the workspace admin's reach. */
  organization_locked: z.boolean().default(false),
});
export type WorkspaceService = z.infer<typeof workspaceServiceSchema>;

/** `GET /workspace/services`: every member may read it; only admins see who each switch reaches. */
export const workspaceServicesSchema = z.object({ services: z.array(workspaceServiceSchema) });

/** `PUT /workspace/services/{service}`: `warning` when issued access could not all be revoked yet. */
export const workspaceServiceChangeSchema = z.object({
  slug: z.string(),
  enabled: z.boolean(),
  warning: z.string().nullable(),
});
export type WorkspaceServiceChange = z.infer<typeof workspaceServiceChangeSchema>;
