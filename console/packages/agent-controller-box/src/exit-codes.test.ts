import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { ConfigurationError, ReasonedError, UsageError } from './errors';
import {
  EXIT_CONFIGURATION,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_RESTARTING,
  EXIT_REVOKED,
  EXIT_TAKEN_OVER,
  exitCodeFor,
} from './exit-codes';
import { defaultDataDir } from './paths';

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('It did not throw.');
}

describe('exit codes', () => {
  it('are the documented numbers', () => {
    expect([EXIT_OK, EXIT_FAILURE, EXIT_CONFIGURATION, EXIT_REVOKED, EXIT_TAKEN_OVER]).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(EXIT_RESTARTING).toBe(7);
  });
});

describe('exitCodeFor', () => {
  it('answers a configuration error, a usage error and a refused argument with 2', () => {
    expect(exitCodeFor(new ConfigurationError('another controller’s data directory'))).toBe(
      EXIT_CONFIGURATION
    );
    expect(exitCodeFor(new UsageError('enroll needs --server'))).toBe(EXIT_CONFIGURATION);
    const parseError = thrown(() =>
      parseArgs({ args: ['--nope'], options: { server: { type: 'string' } }, strict: true })
    );
    expect(exitCodeFor(parseError)).toBe(EXIT_CONFIGURATION);
    const missingValue = thrown(() =>
      parseArgs({ args: ['--server'], options: { server: { type: 'string' } }, strict: true })
    );
    expect(exitCodeFor(missingValue)).toBe(EXIT_CONFIGURATION);
  });

  it('answers what may pass with 1: the network, the server, a crash', () => {
    expect(exitCodeFor(new TypeError('fetch failed'))).toBe(EXIT_FAILURE);
    expect(
      exitCodeFor(new ControllerApiError(503, 'unavailable', 'Switch is restarting', true, 5))
    ).toBe(EXIT_FAILURE);
    expect(exitCodeFor(new ReasonedError('definition_invalid', 'bad'))).toBe(EXIT_FAILURE);
    expect(exitCodeFor(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))).toBe(
      EXIT_FAILURE
    );
    expect(exitCodeFor('a string')).toBe(EXIT_FAILURE);
    expect(exitCodeFor(null)).toBe(EXIT_FAILURE);
  });

  it('answers an unresolvable data directory with 2', () => {
    expect(
      exitCodeFor(thrown(() => defaultDataDir({ platform: 'win32', env: {}, home: 'C:\\a' })))
    ).toBe(EXIT_CONFIGURATION);
  });
});
