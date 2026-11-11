# Zendesk: disabled catalog groundwork

Zendesk stays `enabled: false`, showing **Coming soon**, as
[approved in #843](https://github.com/sandbox-quantum/switch/issues/843#issuecomment-6624736482).
No official Support MCP endpoint or suitable ticket CLI is configured. The
entry cannot connect or grant access and ships no skill. No ticket tools,
community server, per-account OAuth or broker changes are included.

The identity configuration describes Show Self over HTTPS with Basic
`{email}/token` and the existing token. The subdomain is an ASCII DNS label
under `zendesk.com`; user input cannot select another domain. All fields are
validated before HTTP, redirects are refused, and a positive `user.id` is
required: HTTP 200 with an anonymous user does not authenticate a connection.
The returned `user.email` labels the account. Tests use synthetic authenticated
and anonymous response shapes from the
[Users reference](https://developer.zendesk.com/api-reference/ticketing/users/users/#show-self),
as accepted by the maintainer. **No live Zendesk account was tested.**

[API-token retirement](https://developer.zendesk.com/documentation/authentication/oauth-migration/):
accounts created from July 28, 2026 cannot use API tokens; new token creation
ended October 27, 2026. Tokens unused for 30 days are deactivated, and all
remaining tokens end April 30, 2027. Verification with an accepted live token
needs an older account with an existing active token; a new trial cannot
supply one. No such account or credential is available for this contribution.

Tokens have no scope-based read-only restriction and only Zendesk can revoke
them. Switch never grants a non-expiring key to agents. A future activation
requires a separately approved official transport and secure credential
handling (or an approved OAuth design); adding a transport alone is insufficient.

Pattern fields reuse the existing text input for public non-choice values;
Core enforces the catalog's linear-time pattern and independent URL-component
bounds. Existing choice fields and header authentication keep their contract.
Basic authentication uses `httpx.BasicAuth`; an Authorization header cannot
be configured alongside it. No new dependencies or authentication UI are needed.
