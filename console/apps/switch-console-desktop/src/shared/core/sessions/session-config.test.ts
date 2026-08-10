import { describe, expect, it } from 'vitest';
import { sessionConfig, isDroidProviderSessionId } from './session-config';

describe('session-config', () => {
  it('parses autoApprove and providerSessionId', () => {
    const result = sessionConfig.safeParse({
      autoApprove: true,
      providerSessionId: '31477a03-961a-4451-82d4-efded56947fc',
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data).toEqual({
        autoApprove: true,
        providerSessionId: '31477a03-961a-4451-82d4-efded56947fc',
      });
    }
  });

  it('returns invalid for non-object input', () => {
    expect(sessionConfig.safeParse('not-json')).toMatchObject({ status: 'invalid' });
    expect(sessionConfig.safeParse(null)).toMatchObject({ status: 'invalid' });
  });

  it('round-trips through parseJson and serialize', () => {
    const config = { autoApprove: false, providerSessionId: 'abc' };
    const json = sessionConfig.serialize(config);
    expect(sessionConfig.parseJson(json)).toEqual(config);
  });

  it('parseJson returns null for invalid JSON', () => {
    expect(sessionConfig.parseJson('not-json')).toBeNull();
  });

  it('parseJson returns null for null input', () => {
    expect(sessionConfig.parseJson(null)).toBeNull();
  });

  it('validates Droid session ids as UUIDs', () => {
    expect(isDroidProviderSessionId('31477a03-961a-4451-82d4-efded56947fc')).toBe(true);
    expect(isDroidProviderSessionId('session-1')).toBe(false);
    expect(isDroidProviderSessionId('')).toBe(false);
  });
});
