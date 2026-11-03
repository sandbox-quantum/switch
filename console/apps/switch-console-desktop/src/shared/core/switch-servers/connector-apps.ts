import { z } from 'zod';

/**
 * The apps the server's operator sets up for connectors to sign in through:
 * GitHub's App and the OAuth clients registered at a vendor (Google's,
 * Airtable's). One
 * app serves every workspace on the server, so every route behind these is
 * the operator's alone. No answer carries a secret: a client secret shows its
 * last four characters, a private key its fingerprint.
 */

export const connectorAppFieldSchema = z.enum(['client_id', 'client_secret', 'private_key']);
export type ConnectorAppField = z.infer<typeof connectorAppFieldSchema>;

/** Whether a secret is set, and how the operator recognises it; never the secret. */
const connectorAppSecretSchema = z.object({
  set: z.boolean(),
  /** A client secret's last four characters. */
  last4: z.string().nullable().optional(),
  /** A private key's SHA-256 fingerprint, as GitHub lists it. */
  fingerprint: z.string().nullable().optional(),
});

/** The app one connector signs in through, and where it comes from. */
export const connectorAppSchema = z.object({
  slug: z.string(),
  name: z.string(),
  kind: z.enum(['github_app', 'oauth_client']),
  source: z.enum(['configuration', 'saved', 'none']),
  /** The variables that set it from configuration. */
  configuration_variables: z.array(z.string()),
  /** GitHub's HOSTED_GITHUB_CONFIG_PATH: no private key, so it can't be copied. */
  deprecated: z.boolean(),
  client_id: z.string().nullable(),
  /** The client saved here, when there is one. */
  saved_client_id: z.string().nullable(),
  fields: z.object({ slug: z.string().nullable().optional() }),
  secrets: z.record(z.string(), connectorAppSecretSchema),
  /** Saved here, but configuration is set, so Switch uses that. */
  saved_ignored: z.boolean(),
  /** Saved here under a key the server no longer has. */
  unreadable: z.boolean(),
  /** Why the app saved here can't be used. */
  load_error: z.string().nullable(),
  /** Where the vendor sends people back to Switch; null without a public URL it accepts. */
  redirect_uri: z.string().nullable(),
  /**
   * Every address to register at the vendor: Core's own callback, or one per
   * port of Switch Console's listener. A server older than this sends only
   * `redirect_uri`; read both through `redirectUris`.
   */
  redirect_uris: z.array(z.string()).optional(),
  /** Whether the vendor sends people back to the server, so it needs a public URL. */
  needs_public_url: z.boolean().default(true),
  /** The scopes a sign-in asks for, where the vendor's app must list them. */
  scopes: z.array(z.string()).default([]),
  /** Why it can't be set up here, before any vendor is asked. */
  setup_blocked: z.string().nullable(),
  install_url: z.string().nullable(),
  updated_by_name: z.string().nullable(),
  updated_at: z.string().nullable(),
  connected_members: z.number().int(),
  workspaces: z.number().int(),
  /** Connections made through an app this server no longer uses. */
  stale_connections: z.number().int(),
});
export type ConnectorApp = z.infer<typeof connectorAppSchema>;

export function redirectUris(app: Pick<ConnectorApp, 'redirect_uri' | 'redirect_uris'>): string[] {
  if (app.redirect_uris !== undefined) return app.redirect_uris;
  return app.redirect_uri === null ? [] : [app.redirect_uri];
}

/** `GET /connector-apps`. A service whose client Core registers itself is not the operator's to set up. */
export const connectorAppsSchema = z.object({
  public_url: z.string().nullable(),
  apps: z.array(connectorAppSchema),
});
export type ConnectorApps = z.infer<typeof connectorAppsSchema>;

export const connectorAppCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  message: z.string(),
  field: connectorAppFieldSchema.nullable(),
  /** What the check could not see, for the operator to confirm themselves. */
  note: z.string().nullable().default(null),
});
export type ConnectorAppCheck = z.infer<typeof connectorAppCheckSchema>;

/** `POST /connector-apps/{service}/check`: the vendor asked about the app in use. */
export const connectorAppCheckResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(connectorAppCheckSchema),
});
export type ConnectorAppCheckResult = z.infer<typeof connectorAppCheckResultSchema>;

/** `PUT /connector-apps/{service}`: the saved app, and what its check said. */
export const savedConnectorAppSchema = connectorAppSchema.extend({
  checks: z.array(connectorAppCheckSchema).default([]),
});

/** Who is connected through an app, or would have to reconnect if another replaced it. */
export const connectorAppImpactSchema = z.object({
  connected_members: z.number().int(),
  workspaces: z.number().int(),
});
export type ConnectorAppImpact = z.infer<typeof connectorAppImpactSchema>;

/** A 422 from a save the vendor refused: what it said, and the value to look at again. */
export const connectorAppRefusalSchema = z.object({
  detail: z.string(),
  field: connectorAppFieldSchema.nullable(),
  checks: z.array(connectorAppCheckSchema),
});

export type SaveConnectorAppInput = {
  client_id: string;
  /** Left out, the saved one is kept. */
  client_secret?: string;
  private_key?: string;
  /** Switching to another app on purpose: everyone connected must reconnect. */
  replace: boolean;
};

/**
 * A save's outcome. A refusal is an answer, not a failure: the vendor said
 * what is wrong and with which value, which the form shows beside it. Any
 * other failure is thrown.
 */
export type SaveConnectorAppResult =
  | {
      kind: 'saved';
      app: ConnectorApp;
      /** What the vendor said when Switch checked the app it saved; none from an older server. */
      checks: ConnectorAppCheck[];
    }
  | {
      kind: 'refused';
      message: string;
      field: ConnectorAppField | null;
      checks: ConnectorAppCheck[];
    };
