import { describe, expect, it } from 'vitest';
import { knownPasteMethods, serviceConnectionsSchema } from './connection-catalog';

const entry = {
  slug: 'example',
  name: 'Example',
  category: 'Observability',
  description: 'Metrics.',
  enabled: true,
  auth_type: 'oauth',
  connectable: true,
  unavailable_reason: null,
  status: 'active',
};

describe('the service connections answer', () => {
  it('reads how a connection was made and what was picked to make it', () => {
    const [connection] = serviceConnectionsSchema.parse({
      connections: [{ ...entry, method: 'oauth', choices: { site: 'eu.example.com' } }],
    }).connections;
    expect(connection.method).toBe('oauth');
    expect(connection.choices).toEqual({ site: 'eu.example.com' });
  });

  it('reads neither from a server that predates them', () => {
    const [connection] = serviceConnectionsSchema.parse({ connections: [entry] }).connections;
    expect(connection.method).toBeNull();
    expect(connection.choices).toBeNull();
  });

  it('reads what a sign-in asks the person to pick first, and none from an older server', () => {
    const site = {
      name: 'site',
      label: 'Datadog site',
      secret: false,
      help: 'The address you open Datadog at, without app.',
      choices: ['datadoghq.com', 'datadoghq.eu'],
    };
    const [asks] = serviceConnectionsSchema.parse({
      connections: [{ ...entry, sign_in_choices: [site] }],
    }).connections;
    expect(asks.sign_in_choices).toEqual([site]);
    const [older] = serviceConnectionsSchema.parse({ connections: [entry] }).connections;
    expect(older.sign_in_choices).toBeNull();
  });

  it('reads what a service takes pasted, and what a pasted connection reaches', () => {
    const token = {
      method: 'token',
      label: 'Personal access token',
      fields: [
        { name: 'pat', label: 'Personal access token', secret: true, help: null, choices: null },
      ],
      help_url: null,
      expires: 'vendor',
      access_note: 'Reaches what your token allows.',
    };
    const [connection] = serviceConnectionsSchema.parse({
      connections: [
        {
          ...entry,
          paste: [token],
          method: 'token',
          access_note: 'Reaches what your token allows.',
          status: 'needs_reauthorization',
          reconnect_code: 'token_refused',
          reconnect_reason: 'Example refused the pasted token. Paste a new one.',
        },
      ],
    }).connections;
    // A server from before prefilled forms sends no create_url.
    expect(connection.paste).toEqual([{ ...token, create_url: null }]);
    expect([
      connection.access_note,
      connection.reconnect_code,
      connection.reconnect_reason,
    ]).toEqual([
      'Reaches what your token allows.',
      'token_refused',
      'Example refused the pasted token. Paste a new one.',
    ]);
  });

  it('reads nothing pasted and no reason to reconnect from a server that predates them', () => {
    const [connection] = serviceConnectionsSchema.parse({ connections: [entry] }).connections;
    expect(connection.paste).toEqual([]);
    expect([
      connection.access_note,
      connection.reconnect_code,
      connection.reconnect_reason,
    ]).toEqual([null, null, null]);
  });

  it('refuses a paste method that does not say what to paste', () => {
    expect(() =>
      serviceConnectionsSchema.parse({
        connections: [{ ...entry, paste: [{ method: 'token', label: 'Token' }] }],
      })
    ).toThrow();
  });

  it('reads neither for a service the person has not connected', () => {
    const [connection] = serviceConnectionsSchema.parse({
      connections: [{ ...entry, status: 'not_connected', method: null, choices: null }],
    }).connections;
    expect([connection.method, connection.choices]).toEqual([null, null]);
  });
});

describe('the paste methods this Console offers', () => {
  const keys = {
    method: 'keys',
    label: 'API and application keys',
    fields: [{ name: 'api_key', label: 'API key', secret: true, help: null, choices: null }],
    help_url: 'https://docs.example.test/keys',
    create_url: null,
    expires: 'never',
    access_note: 'Reaches what your keys allow.',
  };

  it('keeps the ones it knows, as they are', () => {
    expect(knownPasteMethods([keys])).toEqual([keys]);
  });

  it('leaves out a method, or an expiry, a newer server sends that it does not know', () => {
    expect(
      knownPasteMethods([
        { ...keys, method: 'certificate' },
        { ...keys, expires: 'yearly' },
        { ...keys, method: 'token', expires: 'vendor' },
      ])
    ).toEqual([{ ...keys, method: 'token', expires: 'vendor' }]);
  });
});
