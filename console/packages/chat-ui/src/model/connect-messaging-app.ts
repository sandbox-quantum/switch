import type { BridgeConfigField } from '../contracts/switch-servers';

/** Field names that hold a credential and are typed masked, where the schema
 * gives no `format: "password"` hint. */
const SECRET_FIELD_RE = /token|password|secret|api[_-]?key|private[_-]?key|credential/i;

/** JSON Schema as Pydantic's `model_json_schema()` emits it for a messaging app's config. */
type BridgeConfigSchemaProperty = {
  title?: string;
  description?: string;
  format?: string;
  type?: string;
  default?: unknown;
  /** Pydantic emits `bool | None` as `anyOf: [{type:"boolean"},{type:"null"}]`
   * rather than a top-level `type`, so look through it. */
  anyOf?: Array<{ type?: string }>;
};

export type BridgeConfigSchema = {
  properties?: Record<string, BridgeConfigSchemaProperty>;
  required?: string[];
};

function primitiveType(prop: BridgeConfigSchemaProperty): string | undefined {
  if (prop.type) return prop.type;
  return prop.anyOf?.find((variant) => variant.type && variant.type !== 'null')?.type;
}

function humanizeFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The fields a messaging app's config schema asks for, in the schema's order. */
export function bridgeConfigFields(schema: BridgeConfigSchema): BridgeConfigField[] {
  const required = new Set(schema.required ?? []);
  // Object key order follows the Pydantic model's field order, which puts the
  // required credentials before the optional tuning knobs — worth preserving,
  // so the form reads the way the platform's setup docs do.
  return Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const kind = primitiveType(prop) === 'boolean' ? 'boolean' : 'string';
    const fallback = kind === 'boolean' ? false : null;
    return {
      key,
      label: prop.title ?? humanizeFieldKey(key),
      description: prop.description ?? null,
      required: required.has(key),
      secret: prop.format === 'password' || SECRET_FIELD_RE.test(key),
      kind,
      default:
        typeof prop.default === 'string' || typeof prop.default === 'boolean'
          ? prop.default
          : fallback,
    };
  });
}

/** Fields a server's own app cannot work without, asked for as required even
 * where an older server's schema leaves them optional: a Discord bridge with no
 * bot token opens no connection and receives nothing. */
const OWN_APP_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  discord: ['bot_token'],
};

/** What each field is called in plain words, per platform, where the
 * server's own label is its config key title-cased ("Guild Id"). A field not
 * listed keeps the server's label. */
const FIELD_LABELS: Record<string, Readonly<Record<string, string>>> = {
  discord: { bot_token: 'Bot token', guild_id: 'Server ID' },
  telegram: { bot_token: 'Bot token', bot_username: 'Bot username' },
  teams: {
    app_id: 'App ID',
    app_password: 'App password (client secret)',
    tenant_id: 'Directory (tenant) ID',
    team_id: 'Team ID',
    public_base_url: 'Public HTTPS address',
  },
};

/** The platform's fields, labelled in plain words, with the ones the form
 * insists on marked required whatever the schema says. `alsoRequired` is what
 * a setup guide adds. */
export function connectFormFields(
  platform: string,
  fields: readonly BridgeConfigField[],
  alsoRequired: readonly string[]
): BridgeConfigField[] {
  const forced = [...alsoRequired, ...(OWN_APP_REQUIRED_FIELDS[platform] ?? [])];
  const labels = FIELD_LABELS[platform] ?? {};
  return fields.map((field) => ({
    ...field,
    label: labels[field.key] ?? field.label,
    required: field.required || forced.includes(field.key),
  }));
}

/** A required field still left blank. `false` is an answer, not an omission —
 * only a blank string is missing. */
export function isMissingRequired(
  field: BridgeConfigField,
  config: Record<string, string | boolean>
): boolean {
  if (!field.required) return false;
  const value = config[field.key];
  if (typeof value === 'boolean') return false;
  return !(value ?? '').trim();
}

/** What is still needed before the form can be submitted, or null when nothing is. */
export function missingFieldsMessage(
  fields: readonly BridgeConfigField[],
  config: Record<string, string | boolean>
): string | null {
  const labels = fields.filter((field) => isMissingRequired(field, config)).map((f) => f.label);
  if (labels.length === 0) return null;
  return `${labels.join(', ')} ${labels.length === 1 ? 'is' : 'are'} required to connect.`;
}

/** What an untouched form posts for each field: the schema's default. */
export function fieldDefaults(fields: readonly BridgeConfigField[]): Record<string, string | boolean> {
  const defaults: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (field.default !== null) defaults[field.key] = field.default;
  }
  return defaults;
}

/** The config posted: only the fields the platform declares, text trimmed and
 * blanks left out. A value left over from a field no longer shown must not ride along. */
export function connectionConfigFor(
  fields: readonly BridgeConfigField[],
  config: Record<string, string | boolean>
): Record<string, string | boolean> {
  const connectionConfig: Record<string, string | boolean> = {};
  for (const field of fields) {
    const value = config[field.key];
    if (typeof value === 'boolean') {
      connectionConfig[field.key] = value;
      continue;
    }
    const trimmed = (value ?? '').trim();
    if (trimmed) connectionConfig[field.key] = trimmed;
  }
  return connectionConfig;
}

/** Private, link-local and unique-local IPv4 and IPv6 ranges: addresses no
 * one outside the network can reach. */
const PRIVATE_HOST =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|f[cd][0-9a-f]{2}:|fe80:))/i;

/** Whether `url` is a loopback, private or `.local` address nobody outside its network can reach. */
export function privateAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'local' ||
    host.endsWith('.local') ||
    PRIVATE_HOST.test(host)
  );
}

/** The platforms whose own-app setup is walked through step by step. */
export const GUIDED_PLATFORMS = ['slack'] as const;
export type GuidedPlatform = (typeof GUIDED_PLATFORMS)[number];

export function isGuidedPlatform(key: string | null | undefined): key is GuidedPlatform {
  return GUIDED_PLATFORMS.includes(key as GuidedPlatform);
}

/** The tokens the guide needs, asked for as required whatever the schema says:
 * on a server's own app they are, even where a shared app makes them optional. */
export const GUIDE_REQUIRED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['bot_token', 'app_token'],
};

/** The fields the guide fills in itself, which the form does not ask for. */
export const GUIDE_FILLED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['workspace_id'],
};

/** The fields the guide asks for itself, each in the step that says where to
 * find it, so the form does not ask for them again below. */
export const GUIDE_ASKED_FIELDS: Record<GuidedPlatform, readonly string[]> = {
  slack: ['bot_token', 'app_token'],
};
