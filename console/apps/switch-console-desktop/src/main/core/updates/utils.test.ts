import { describe, expect, it } from 'vitest';
import { formatUpdaterError, updaterErrorCode } from './utils';

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
    const error = Object.assign(new Error('the request was refused'), { statusCode: 'nope' });

    expect(formatUpdaterError(error)).toBe('the request was refused');
  });

  it('describes a value that is not an error', () => {
    expect(formatUpdaterError('plain text')).toBe('plain text');
    expect(formatUpdaterError(undefined)).toBe('Unknown update error');
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
