import { describe, expect, it } from 'vitest';
import { serviceConnectionsSchema } from './connection-catalog';

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

  it('reads neither for a service the person has not connected', () => {
    const [connection] = serviceConnectionsSchema.parse({
      connections: [{ ...entry, status: 'not_connected', method: null, choices: null }],
    }).connections;
    expect([connection.method, connection.choices]).toEqual([null, null]);
  });
});
