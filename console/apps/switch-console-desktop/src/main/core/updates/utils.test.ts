import { describe, expect, it } from 'vitest';
import { formatUpdaterError, sanitizeUpdaterLogArgs, updaterErrorCode } from './utils';

/** The shape builder-util-runtime's `newError` gives electron-updater's own failures. */
function updaterError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The shape builder-util-runtime's `HttpError` gives a failed request. */
function httpError(statusCode: number, description: string | null): Error {
  return Object.assign(new Error(`HTTP error: ${statusCode}`), {
    statusCode,
    description,
    code: `HTTP_ERROR_${statusCode}`,
  });
}

describe('formatUpdaterError', () => {
  it.each([
    ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'No published versions on GitHub'],
    ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'Cannot find latest-mac.yml in the latest release'],
  ])('shows what the updater said for %s, not an HTTP status', (code, message) => {
    const text = formatUpdaterError(updaterError(message, code));

    expect(text).toBe(message);
    expect(text).not.toContain('HTTP');
  });

  it('keeps the stack trace and feed XML of an unreadable feed out of the text', () => {
    const error = updaterError(
      'Cannot parse releases feed: TypeError: x is null\n    at parse (feed.js:1:1),\nXML:\n<?xml version="1.0"?><feed></feed>',
      'ERR_UPDATER_INVALID_RELEASE_FEED'
    );

    expect(formatUpdaterError(error)).toBe('Cannot parse releases feed: TypeError: x is null');
  });

  it('says HTTP for a numeric status code', () => {
    expect(formatUpdaterError(httpError(503, 'Service Unavailable'))).toBe(
      'Update request failed with HTTP 503: Service Unavailable'
    );
    expect(formatUpdaterError(httpError(404, null))).toBe('Update request failed with HTTP 404');
  });

  it('shows the message for a network error code', () => {
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), {
      code: 'ENOTFOUND',
    });

    expect(formatUpdaterError(error)).toBe('getaddrinfo ENOTFOUND github.com');
  });

  it('does not call a non-numeric status an HTTP status', () => {
    const error = Object.assign(new Error('the request was refused'), {
      statusCode: 'nope',
    });

    expect(formatUpdaterError(error)).toBe('the request was refused');
  });

  it('describes a value that is not an error', () => {
    expect(formatUpdaterError('plain text')).toBe('plain text');
    expect(formatUpdaterError(undefined)).toBe('Unknown update error');
  });
});

describe('formatUpdaterError at the edges', () => {
  it('prefers the updater message to a status code on the same error', () => {
    const error = Object.assign(updaterError('No published versions on GitHub', 'ERR_UPDATER_X'), {
      statusCode: 404,
    });

    expect(formatUpdaterError(error)).toBe('No published versions on GitHub');
  });

  it('says it does not know when an updater error has no message', () => {
    expect(formatUpdaterError(updaterError('', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe(
      'Unknown update error'
    );
  });

  it('drops the carriage return of a Windows line ending', () => {
    const error = updaterError('Cannot find channel file\r\n    at x (y.js:1:1)', 'ERR_UPDATER_X');

    expect(formatUpdaterError(error)).toBe('Cannot find channel file');
  });

  it('truncates a long first line', () => {
    const text = formatUpdaterError(updaterError('a'.repeat(300), 'ERR_UPDATER_X'));

    expect(text).toBe(`${'a'.repeat(240)}…`);
  });

  it('keeps an HTML error page out of the status text', () => {
    const error = Object.assign(new Error('HTTP error: 502'), {
      statusCode: 502,
      statusMessage: 'Bad Gateway <!DOCTYPE html><html><body>nginx</body></html>',
    });

    expect(formatUpdaterError(error)).toBe('Update request failed with HTTP 502: Bad Gateway');
  });

  it('prefers the status message to the description', () => {
    const error = Object.assign(httpError(500, 'from description'), {
      statusMessage: 'Internal Server Error',
    });

    expect(formatUpdaterError(error)).toBe(
      'Update request failed with HTTP 500: Internal Server Error'
    );
  });

  it('does not take a numeric code for an HTTP status', () => {
    const error = Object.assign(new Error('socket hang up'), { code: 404 });

    expect(formatUpdaterError(error)).toBe('socket hang up');
    expect(updaterErrorCode(error)).toBeUndefined();
  });

  it('skips an empty first line to find the sentence', () => {
    const error = updaterError('\nCannot find channel file\n    at x (y.js:1:1)', 'ERR_UPDATER_X');

    expect(formatUpdaterError(error)).toBe('Cannot find channel file');
  });

  it('describes null like undefined', () => {
    expect(formatUpdaterError(null)).toBe('Unknown update error');
  });
});

describe('sanitizeUpdaterLogArgs', () => {
  it('logs only the first line of an updater error', () => {
    const error = updaterError(
      'Cannot parse feed\nXML:\n<feed/>',
      'ERR_UPDATER_INVALID_RELEASE_FEED'
    );

    expect(sanitizeUpdaterLogArgs(['Error:', error, 42])).toEqual([
      'Error:',
      'Cannot parse feed',
      42,
    ]);
  });
});

describe('updaterErrorCode', () => {
  it('returns the code to log, when there is one', () => {
    expect(updaterErrorCode(updaterError('x', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe(
      'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    );
    expect(updaterErrorCode(new Error('x'))).toBeUndefined();
    expect(updaterErrorCode(null)).toBeUndefined();
  });
});
