import { urlHost } from '@shared/core/switch-servers/switch-servers';

/**
 * Why a request to a server never got an answer, in words a person can act on.
 *
 * Node's `fetch` rejects with `TypeError: fetch failed` whatever went wrong; the
 * reason (`ENOTFOUND`, `ECONNREFUSED`, a certificate the system does not trust)
 * is on its `cause`, sometimes a level further down. Reporting the outer
 * message tells someone who mistyped an address the same thing as someone
 * whose server is down.
 */

type Reason = { text: string; code: string | null };

const REASON_BY_CODE: Record<string, string> = {
  ENOTFOUND:
    "this address wasn't found. Check it for typos, or connect to your VPN if the server is private",
  EAI_AGAIN: 'the name lookup failed. Check your network connection',
  EAI_NONAME:
    "this address wasn't found. Check it for typos, or connect to your VPN if the server is private",
  ECONNREFUSED: 'nothing is answering at that address and port',
  ECONNRESET: 'the connection was closed before the server answered',
  EHOSTUNREACH: "there's no network route to it. Check that you're on its network or VPN",
  ENETUNREACH: "there's no network route to it. Check that you're on its network or VPN",
  ETIMEDOUT: "the connection timed out. Check that you're on its network or VPN",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out. Check that you're on its network or VPN",
  UND_ERR_HEADERS_TIMEOUT: 'it accepted the connection but never answered',
  UND_ERR_SOCKET: 'the connection was closed before the server answered',
  EPROTO: 'the secure connection failed. Check whether the address should be http or https',
  ERR_SSL_WRONG_VERSION_NUMBER:
    'the secure connection failed. Check whether the address should be http or https',
  ERR_TLS_CERT_ALTNAME_INVALID: "its certificate doesn't match the address",
  CERT_HAS_EXPIRED: 'its certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: "its certificate is self-signed and this computer doesn't trust it",
  SELF_SIGNED_CERT_IN_CHAIN: "its certificate is self-signed and this computer doesn't trust it",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "this computer doesn't trust its certificate",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "this computer doesn't trust its certificate",
};

function codeOf(error: object): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** The innermost error in a `cause` chain, and the first code that names a known reason. */
function reasonOf(error: unknown): Reason {
  let innermost: unknown = error;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.name === 'TimeoutError') {
      return { text: "the server didn't answer in time", code: null };
    }
    const code = codeOf(current);
    if (code && REASON_BY_CODE[code]) return { text: REASON_BY_CODE[code], code };
    innermost = current;
    current = current.cause;
  }
  const code = innermost instanceof Error ? codeOf(innermost) : null;
  const message = innermost instanceof Error ? innermost.message : String(innermost);
  return { text: message.trim().replace(/\.+$/, '') || 'the request failed', code };
}

/**
 * One sentence naming the address and the reason, with the system's own code
 * in brackets so it can be searched for: "Can't reach switch.example.test: this
 * address wasn't found. Check it for typos, or connect to your VPN if the server
 * is private (ENOTFOUND)."
 */
export function describeNetworkFailure(url: string, error: unknown): string {
  const { text, code } = reasonOf(error);
  const suffix = code && !text.includes(code) ? ` (${code})` : '';
  return `Can't reach ${urlHost(url)}: ${text}${suffix}.`;
}
