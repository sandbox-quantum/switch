import type { Redactions } from './redaction';

/**
 * A service token as a session host uses it. Most are one opaque string (an
 * OAuth access token, a GitHub installation token). A service connected with
 * a pasted key hands out compact JSON instead, `{"public":{...},"secret":{...}}`,
 * the fields its owner pasted (the keys) and picked (a site), which the
 * grant's templates put where the vendor takes them: an MCP request's headers
 * and URL, a CLI run's environment.
 *
 * In a template, `{token}` is the whole token and `{name}` the field of that
 * name; anything else in braces is an error, never left in or dropped.
 */

/** What a template names: the whole token. Core never names a field this. */
const TOKEN_PLACEHOLDER = 'token';
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** A field value fit for a header, an argument or a URL's host: printable ASCII, no spaces. */
const FIELD_VALUE = /^[\x21-\x7e]+$/;

export class ServiceCredential {
  private constructor(
    readonly token: string,
    /** Every value to scrub: the whole token, and each secret field on its own. */
    readonly secrets: readonly string[],
    private readonly fields: ReadonlyMap<string, string> | null
  ) {}

  static of(token: string): ServiceCredential {
    const fields = keyFields(token);
    if (fields === null) return new ServiceCredential(token, [token], null);
    return new ServiceCredential(
      token,
      [token, ...Object.values(fields.secret)],
      new Map([...Object.entries(fields.public), ...Object.entries(fields.secret)])
    );
  }

  /** `template` with each placeholder replaced by what it names. */
  render(template: string): string {
    const rest = template.replace(PLACEHOLDER, '');
    if (rest.includes('{') || rest.includes('}'))
      throw new Error(`The template ${JSON.stringify(template)} has a brace that names nothing.`);
    return template.replace(PLACEHOLDER, (_, name: string) => {
      if (name === TOKEN_PLACEHOLDER) return this.token;
      const value = this.fields?.get(name);
      if (value === undefined)
        throw new Error(
          this.fields === null
            ? `The template ${JSON.stringify(template)} names {${name}}, but this service's token has no fields; only {${TOKEN_PLACEHOLDER}} can be used.`
            : `The template ${JSON.stringify(template)} names {${name}}, which this service's key does not carry (it has ${[...this.fields.keys()].join(', ')}).`
        );
      return value;
    });
  }
}

type KeyFields = { public: Record<string, string>; secret: Record<string, string> };

/**
 * The fields of a key's token, or null for an opaque token. A token that is a
 * JSON object is a key's, so one of any other shape is refused rather than
 * used whole.
 */
function keyFields(token: string): KeyFields | null {
  if (!token.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const { public: open, secret } = parsed;
  if (
    keys.length !== 2 ||
    keys[0] !== 'public' ||
    keys[1] !== 'secret' ||
    !fieldRecord(open) ||
    !fieldRecord(secret)
  )
    throw new Error(
      'Switch handed out a service key that is not {"public": {...}, "secret": {...}} of one-line values.'
    );
  const shared = Object.keys(open).filter((name) => Object.hasOwn(secret, name));
  if (shared.length)
    throw new Error(`Switch handed out a service key naming ${shared.join(', ')} twice.`);
  if (!Object.keys(secret).length)
    throw new Error('Switch handed out a service key without a secret field.');
  return { public: open, secret };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, field]) =>
        name !== TOKEN_PLACEHOLDER && typeof field === 'string' && FIELD_VALUE.test(field)
    )
  );
}

/** Parse a token just handed out and add each of its secrets to `redactions`. */
export function redactServiceToken(redactions: Redactions, token: string): ServiceCredential {
  const credential = ServiceCredential.of(token);
  for (const secret of credential.secrets) redactions.add(secret);
  return credential;
}
