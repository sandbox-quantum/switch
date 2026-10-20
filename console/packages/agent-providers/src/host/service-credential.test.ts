import { describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import { redactServiceToken, ServiceCredential } from './service-credential';

const API_KEY = 'api-key-xxxxxxxx';
const APP_KEY = 'app-key-xxxxxxxx';
const KEY = JSON.stringify({
  public: { site: 'datadoghq.eu' },
  secret: { api_key: API_KEY, application_key: APP_KEY },
});
const OAUTH = 'synthetic-oauth-access-token';

describe('a service credential', () => {
  it('redacts an opaque token whole', () => {
    expect(ServiceCredential.of(OAUTH).secrets).toEqual([OAUTH]);
  });

  it('redacts a key’s token whole and each secret field on its own, not its public ones', () => {
    expect(ServiceCredential.of(KEY).secrets).toEqual([KEY, API_KEY, APP_KEY]);
  });

  it('adds every secret to the redactions, so each is scrubbed alone', () => {
    const redactions = new Redactions();
    const credential = redactServiceToken(redactions, KEY);
    expect(credential.token).toBe(KEY);
    expect(
      redactions.text(`DD_API_KEY=${API_KEY} DD_APPLICATION_KEY=${APP_KEY} site=datadoghq.eu`)
    ).toBe('DD_API_KEY=[REDACTED] DD_APPLICATION_KEY=[REDACTED] site=datadoghq.eu');
    expect(redactions.text(`header ${encodeURIComponent(KEY)}`)).toBe('header [REDACTED]');
  });

  it('renders {token} as the whole token, and a key’s fields by name', () => {
    expect(ServiceCredential.of(OAUTH).render('Bearer {token}')).toBe(`Bearer ${OAUTH}`);
    const key = ServiceCredential.of(KEY);
    expect(key.render('{api_key}')).toBe(API_KEY);
    expect(key.render('https://mcp.{site}/api/unstable/mcp-server/mcp')).toBe(
      'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp'
    );
    expect(key.render('{api_key}:{application_key}')).toBe(`${API_KEY}:${APP_KEY}`);
    expect(key.render('no placeholder')).toBe('no placeholder');
  });

  it('refuses a placeholder the token does not carry', () => {
    expect(() => ServiceCredential.of(KEY).render('{region}')).toThrow(
      'names {region}, which this service’s key does not carry'.replace('’', "'")
    );
    expect(() => ServiceCredential.of(OAUTH).render('{api_key}')).toThrow(
      'only {token} can be used'
    );
    expect(() => ServiceCredential.of(KEY).render('{}')).toThrow('names {}');
  });

  it('refuses a stray brace', () => {
    for (const template of ['Bearer {token', 'token}', '{{token}}', '{a{b}'])
      expect(() => ServiceCredential.of(KEY).render(template)).toThrow('brace that names nothing');
  });

  it('refuses a JSON object that is not a key’s fields, rather than using it whole', () => {
    for (const token of [
      '{"secret":{"api_key":"x"}}',
      '{"public":{},"secret":{"api_key":"x"},"other":{}}',
      '{"public":{},"secret":{"api_key":1}}',
      '{"public":{},"secret":{"api_key":"two words"}}',
      '{"public":{},"secret":{"api_key":"line\\nbreak"}}',
      '{"public":{},"secret":{"token":"x"}}',
      '{"public":{"api_key":"a"},"secret":{"api_key":"b"}}',
      '{"public":{"site":"a"},"secret":{}}',
    ])
      expect(() => ServiceCredential.of(token), token).toThrow('Switch handed out a service key');
  });

  it('takes a token that is not a JSON object as opaque', () => {
    for (const token of ['{not-json', '"quoted"', 'eyJhbGciOiJIUzI1NiJ9.e30.sig'])
      expect(ServiceCredential.of(token).secrets).toEqual([token]);
  });
});
