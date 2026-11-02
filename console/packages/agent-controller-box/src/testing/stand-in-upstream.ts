import { type IncomingMessage, request } from 'node:http';
import type { UpstreamSend } from '../provider-gateway';

/**
 * An upstream transport for tests: the gateway still chooses the provider's
 * real https URL, and this sends the call to a local stand-in instead,
 * keeping its path, query and headers. `chose` sees each URL the gateway chose.
 */
export function standInSend(standIn: () => string, chose?: (url: URL) => void): UpstreamSend {
  return async (url, options) => {
    chose?.(url);
    const target = new URL(`${url.pathname}${url.search}`, standIn());
    const req = request(target, {
      method: options.method,
      headers: options.headers,
      timeout: options.timeoutMs,
    });
    req.on('timeout', () => req.destroy(new Error('the provider went quiet')));
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      req.once('response', resolve);
      req.once('error', reject);
    });
    return { request: req, response };
  };
}
