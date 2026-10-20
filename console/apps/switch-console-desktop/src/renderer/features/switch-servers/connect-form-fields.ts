import type { BridgeConfigField } from '@shared/core/switch-servers/switch-servers';

/** Fields a server's own app cannot work without, asked for as required even
 * where an older server's schema leaves them optional: a Discord bridge with no
 * bot token opens no connection and receives nothing. */
const OWN_APP_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  discord: ['bot_token'],
};

/** The platform's fields, with the ones the form insists on marked required
 * whatever the schema says. `alsoRequired` is what a setup guide adds. */
export function connectFormFields(
  platform: string,
  fields: readonly BridgeConfigField[],
  alsoRequired: readonly string[]
): BridgeConfigField[] {
  const forced = [...alsoRequired, ...(OWN_APP_REQUIRED_FIELDS[platform] ?? [])];
  return fields.map((field) => (forced.includes(field.key) ? { ...field, required: true } : field));
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
