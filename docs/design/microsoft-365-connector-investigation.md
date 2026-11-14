# Microsoft 365 connector: investigation (#822)

This is my write-up for the four questions in Petr's comment on #822. I had no
Work IQ tenant, as expected, so nothing here was tried while signed in. What I
say comes either from Microsoft's documentation or from requests that need no
sign-in. Checked on 4 November 2026 against Switch at `39a722c5`.

## Short answers

**1. Work IQ or Graph?** I'd use Work IQ MCP with a static delegated OAuth app.
It is one remote MCP server covering mail, calendar, files and Teams, which is
the shape Switch already supports. Graph has finer permissions (`Mail.Read`,
`Files.Read`, `Chat.Read` and so on), but I found no way to hand the `mgc` CLI a
token from Switch's broker, so it doesn't fit as it is. Work IQ doesn't support
app-only sign-in.

**2. Licensing and credits?** Microsoft's Copilot Studio blog puts a custom
client like Switch in the “own solution” row, and its Credits Guide (November
2026) says custom Work IQ API use is billed in Copilot Credits even for users
with a Microsoft 365 Copilot licence. The guide lists US$0.01 per credit and 0.1
credit per Tools API call, so US$0.001 per call. Chat and context calls are
priced differently, so this is not a total cost per task. An admin has to enable
Work IQ, grant consent and put the users on a billing plan.

**3. Write policy?** Work IQ's tenant policy blocks writes by default, but it
applies to the whole tenant and an admin can change it, so Switch can't promise
a read-only connection on that basis. The only scope the live server advertises,
`WorkIQAgent.Ask`, includes writes. Microsoft's docs list a `WorkIQ.Read` scope,
but the server doesn't advertise it and I couldn't test whether it is accepted.
If only `Ask` works, the connection has to be labelled write. A skill can set
safe defaults, but it cannot enforce read-only access.

**4. Identity?** Switch identifies an account with an authenticated GET. A Work
IQ token is for Work IQ, while Microsoft's UserInfo endpoint is on Graph and
requires a Graph token, so a Work IQ token isn't valid for that GET. I found no
Work IQ endpoint that returns who the user is. What I'd propose is to validate
the ID token Entra returns with the sign-in (signature, issuer, audience, expiry,
and a nonce tied to the flow), take the subject, and discard the token. I haven't
built it, since Petr said it waits for the report.

## The draft entry

I added a disabled draft entry for `microsoft-365`, with two tests. One shows
the loader rejects the entry if `enabled` is flipped without identity, scopes
and a token lifetime. The other shows the registry doesn't activate it even when
an operator configures a client. The draft has no identity, scopes or token
lifetime because they have not been validated. There is no skill, no Console
change, and no shared OAuth change.

## What anyone can check without signing in

These are the requests behind the answers above. The responses are as of 4
November.

An unauthenticated MCP request to `https://workiq.svc.cloud.microsoft/mcp`
returns `401` and points at its resource metadata. The metadata itself is public:

```bash
curl -fsS https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp \
  | jq '{resource, authorization_servers, scopes_supported}'
```

```json
{
  "resource": "https://workiq.svc.cloud.microsoft/mcp",
  "authorization_servers": ["https://login.microsoftonline.com/organizations/v2.0"],
  "scopes_supported": ["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"]
}
```

Only `WorkIQAgent.Ask` is advertised. Entra's discovery document says:

```bash
curl -fsS https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration \
  | jq '{userinfo_endpoint,
         registration_endpoint_present: has("registration_endpoint"),
         revocation_endpoint_present: has("revocation_endpoint"),
         code_challenge_methods_supported_present: has("code_challenge_methods_supported")}'
```

```json
{
  "userinfo_endpoint": "https://graph.microsoft.com/oidc/userinfo",
  "registration_endpoint_present": false,
  "revocation_endpoint_present": false,
  "code_challenge_methods_supported_present": false
}
```

There is no dynamic-registration endpoint, so the app has to be static. There
is no advertised revocation endpoint, so `remove_access` has to explain how to
remove the app's consent in Microsoft Entra. Switch's OAuth adapter also rejects
a discovery document that doesn't list `S256`, so the draft names the endpoints
explicitly instead of relying on discovery.

Microsoft's permissions page (revised 30 October) lists `WorkIQAgent.Ask`,
`WorkIQ.Act` and `WorkIQ.Read` as delegated permissions that all need admin
consent. Its description of `Ask` says it “includes read and write access”.

## What I couldn't test

- Sign-in with PKCE, identity validation, the redirect, and home versus guest
  tenants.
- Whether `WorkIQ.Read` is accepted, what scope string comes back, and whether
  writes are refused on their own.
- Mail, calendar, OneDrive, SharePoint and Teams calls. The tool reference caps
  list results at 25 by default (100 at most, 10 for chat), blocks `$skip`, and
  defaults raw blobs to 4 MB, so I'd need to see real results.
- Access-token lifetime, refresh behaviour, reauthentication, and what removing
  consent does.
- The room demo, and that the token stays out of logs.

## What I'd like from the maintainers

1. Is Work IQ MCP with a static delegated OAuth app the route you want?
2. For identity: should I build ID-token validation, or wait for Microsoft to
   offer a GET that works with a Work IQ token?
3. If Work IQ's billing makes it unusable, do you want me to look at making
   Graph work through the CLI instead?

## Sources

- [Petr's scope on #822](https://github.com/sandbox-quantum/switch/issues/822#issuecomment-6335481335)
- [Work IQ API overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview)
- [Work IQ permissions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)
- [Work IQ MCP tool reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference)
- [Work IQ MCP policy](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp)
- [Enabling Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Copilot Credits Guide](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/ai/CopilotCreditsGuide.pdf)
- [Copilot Studio blog on Work IQ](https://microsoft.github.io/mcscatblog/posts/work-iq-context-layer-you-already-have/)
- [Entra auth code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Entra ID tokens](https://learn.microsoft.com/en-us/entra/identity-platform/id-tokens)
- [UserInfo endpoint](https://learn.microsoft.com/en-us/entra/identity-platform/userinfo)
