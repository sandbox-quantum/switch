import {
  type BridgeConfigField,
  runsOnThisComputer,
  type SwitchServer,
} from '@shared/core/switch-servers/switch-servers';

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

/** Private, link-local and unique-local IPv4 and IPv6 ranges: addresses no
 * one outside the network can reach. */
const PRIVATE_HOST =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?(::1|f[cd][0-9a-f]{2}:|fe80:))/i;

/**
 * Whether Microsoft could not reach this server, so Teams, which delivers
 * every message to the server's own address, cannot work with it: one Switch
 * Console runs on this computer, or one at a loopback, private or `.local`
 * address.
 */
export function unreachableFromInternet(
  server: Pick<SwitchServer, 'managed' | 'managementKind' | 'url'>
): boolean {
  if (runsOnThisComputer(server)) return true;
  let host: string;
  try {
    host = new URL(server.url).hostname.toLowerCase();
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
