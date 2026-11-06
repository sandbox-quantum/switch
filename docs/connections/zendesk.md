# Zendesk catalog status

Zendesk is listed as **Coming soon**. It is deliberately `enabled: false`:
there is no verified official remote MCP server or suitable CLI transport for
Zendesk Support. This contribution does not add server-side Zendesk tools or
point at a community server. It cannot connect an account or grant an agent
access. No read-only capability is advertised.

The disabled entry records the identity contract for an existing API token:
a validated account label selects `https://{subdomain}.zendesk.com`, and the
standard HTTP Basic username is the verified email plus `/token`, with the API
token as password. Account labels are bounded ASCII identifiers, matched against
the catalog pattern. They occupy a complete host label, never a full hostname,
query, userinfo or port. Secrets appear only in the authentication header.

Zendesk's Show Self endpoint is also available to anonymous callers. HTTP 200
alone therefore cannot validate a credential. The entry requires a positive
user ID and rejects anonymous/null, negative, zero and malformed IDs. The
adapter revalidates submitted fields before constructing a request and never
follows an identity redirect.

API tokens are being retired. Zendesk stopped creating new ones on October 27,
2026; existing tokens are scheduled to stop working on April 30, 2027. This
entry does not encourage creating one. Non-expiring credentials also remain
blocked by Switch's existing policy: only their vendor can revoke them, so they
are never handed to an agent. A future supported transport or Core-mediated
access needs separate design and verification before this entry can be enabled.

## Verification boundary

No Zendesk account or existing token was available. Tests use `httpx.MockTransport`
and obviously synthetic values shaped after the documented authenticated and
anonymous Show Self responses. They test Basic-header construction, identity
acceptance/refusal, unsafe account labels, redirect refusal, loader constraints
and the existing **Coming soon** broker gate. They are not live-account evidence.
The maintainer explicitly accepted documented-response tests and no connect/grant
video for this disabled entry.

## Sources

Checked November 6, 2026:

- [Security and authentication](https://developer.zendesk.com/api-reference/introduction/security-and-auth/)
- [Users: Show Self](https://developer.zendesk.com/api-reference/ticketing/users/users/#show-self)
- [API token retirement](https://support.zendesk.com/hc/en-us/articles/10851263566234-Announcing-the-removal-of-API-tokens-as-an-authentication-method-for-API-requests)
- [Maintainer: disabled entry and documented identity responses](https://github.com/sandbox-quantum/switch/issues/843#issuecomment-6624736482)
- [Shared pattern-field contract](https://github.com/sandbox-quantum/switch/issues/840#issuecomment-6335474275)
