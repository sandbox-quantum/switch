import { describe, expect, it } from 'vitest';
import { EXECUTION_INHERIT_ENV } from './agent-env';
import {
  cliConversationRequestSchema,
  MAX_INHERITED_NAMES,
  MAX_SESSIONS_PER_REQUEST,
} from './cli-conversations';

/** A removal request as Console stages it, naming `consoleSessionIds`. */
function removal(inheritEnv: string[], consoleSessionIds: string[]) {
  return {
    provider: 'claude',
    dir: '/work',
    env: {},
    inheritEnv,
    consoleSessionIds,
  };
}

function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
}

/** Where and why a request was refused, or null when it was accepted. */
function refusal(request: unknown) {
  const result = cliConversationRequestSchema.safeParse(request);
  return result.success
    ? null
    : result.error.issues.map(({ path, code }) => ({ path: path.join('.'), code }));
}

describe('cliConversationRequestSchema', () => {
  it('accepts the names Console inherits and as many sessions as one request may name', () => {
    expect(
      refusal(removal([...EXECUTION_INHERIT_ENV], names('session', MAX_SESSIONS_PER_REQUEST)))
    ).toBeNull();
  });

  it('refuses more inherited names than a request may carry', () => {
    expect(refusal(removal(names('NAME', MAX_INHERITED_NAMES + 1), ['session-1']))).toEqual([
      { path: 'inheritEnv', code: 'too_big' },
    ]);
  });

  it('refuses more sessions than one removal may name', () => {
    expect(refusal(removal(['PATH'], names('session', MAX_SESSIONS_PER_REQUEST + 1)))).toEqual([
      { path: 'consoleSessionIds', code: 'too_big' },
    ]);
  });
});
