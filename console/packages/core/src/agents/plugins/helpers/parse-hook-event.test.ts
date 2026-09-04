import { describe, expect, it } from 'vitest';
import { defaultHookEventParser } from './parse-hook-event';

describe('defaultHookEventParser', () => {
  it('maps stop-failure to an error carrying the reason', () => {
    expect(
      defaultHookEventParser('stop-failure', {
        error_type: 'authentication_failed',
        error_message: 'Vertex AI\n  credentials have expired',
      })
    ).toEqual({
      kind: 'status',
      type: 'error',
      title: 'authentication_failed',
      message: 'authentication_failed — Vertex AI credentials have expired',
    });
  });

  it('never surfaces an empty error when the provider omits a half', () => {
    expect(defaultHookEventParser('stop-failure', { error_type: 'rate_limit' })).toMatchObject({
      message: 'rate_limit',
    });
    expect(defaultHookEventParser('stop-failure', { error_message: 'upstream 503' })).toMatchObject(
      { message: 'upstream 503' }
    );
    expect(defaultHookEventParser('stop-failure', {})).toMatchObject({
      type: 'error',
      message: 'the turn ended on an error',
    });
  });
});
