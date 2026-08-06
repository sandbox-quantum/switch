import { describe, expect, it } from 'vitest';
import { sessionConnectionId, uuidV5 } from './session-connection-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the published vector for the DNS namespace', () => {
    // The canonical v5 answer every UUID library agrees on. This is what says
    // the hand-rolled implementation is a real UUIDv5 and not merely stable.
    const dns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5('www.example.com', dns)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('separates the namespace from the name', () => {
    const a = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const b = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5('same-name', a)).not.toBe(uuidV5('same-name', b));
  });
});

describe('sessionConnectionId', () => {
  // The bug this exists to prevent: a restarted supervisor must recompute the
  // id the already-running agent is still stamping on its tool calls.
  it('is the same id every time for a session', () => {
    const first = sessionConnectionId('7c2f0f2e-1f1a-4c1e-9d6b-2f8a1d3c4b5e');
    const second = sessionConnectionId('7c2f0f2e-1f1a-4c1e-9d6b-2f8a1d3c4b5e');
    expect(second).toBe(first);
  });

  it('is stable across process boundaries', () => {
    // Pinned literally, not recomputed: a change to the namespace or the hash
    // would still pass a self-consistency check while repointing every live
    // session at a connection its agent has never heard of.
    expect(sessionConnectionId('7c2f0f2e-1f1a-4c1e-9d6b-2f8a1d3c4b5e')).toBe(
      '47b895fe-7db3-5dc1-a137-4876fbe80485'
    );
  });

  it('gives different sessions different connections', () => {
    expect(sessionConnectionId('session-a')).not.toBe(sessionConnectionId('session-b'));
  });

  it('produces a well-formed v5 UUID the server will accept', () => {
    for (const sessionId of ['session-a', '', 'ünïcode-session', 'x'.repeat(500)]) {
      expect(sessionConnectionId(sessionId)).toMatch(UUID_RE);
    }
  });
});
