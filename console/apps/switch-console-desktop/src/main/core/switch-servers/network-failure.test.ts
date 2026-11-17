import { describe, expect, it } from 'vitest';
import { describeNetworkFailure } from './network-failure';

/** What Node's `fetch` rejects with: the reason sits on `cause`. */
function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('describeNetworkFailure', () => {
  it('says an address that does not resolve does not resolve', () => {
    const error = fetchFailed(systemError('ENOTFOUND', 'getaddrinfo ENOTFOUND bad.invalid'));

    expect(describeNetworkFailure('https://bad.invalid', error)).toBe(
      "Can't reach bad.invalid: the address doesn't resolve. Check it for typos (ENOTFOUND)."
    );
  });

  it('says nothing is answering when the connection is refused', () => {
    const error = fetchFailed(systemError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8000'));

    expect(describeNetworkFailure('http://localhost:8000/', error)).toBe(
      "Can't reach localhost:8000: nothing is answering at that address and port (ECONNREFUSED)."
    );
  });

  it('finds the code on a cause nested further down', () => {
    const error = fetchFailed(
      Object.assign(new Error('connect timeout'), {
        cause: systemError('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'),
      })
    );

    expect(describeNetworkFailure('https://switch.example.test', error)).toMatch(
      /^Can't reach switch\.example\.test: the connection timed out\..*\(UND_ERR_CONNECT_TIMEOUT\)\.$/
    );
  });

  it('says a request given up on did not get an answer in time', () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    expect(describeNetworkFailure('https://switch.example.test', error)).toBe(
      "Can't reach switch.example.test: the server didn't answer in time."
    );
  });

  it('names a certificate this computer does not trust', () => {
    const error = fetchFailed(
      systemError('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate')
    );

    expect(describeNetworkFailure('https://switch.example.test', error)).toMatch(
      /self-signed and this computer doesn't trust it \(DEPTH_ZERO_SELF_SIGNED_CERT\)\.$/
    );
  });

  it('falls back to the innermost message for a reason it does not know', () => {
    const error = fetchFailed(systemError('EWEIRD', 'something odd happened.'));

    expect(describeNetworkFailure('https://switch.example.test', error)).toBe(
      "Can't reach switch.example.test: something odd happened (EWEIRD)."
    );
  });
});
