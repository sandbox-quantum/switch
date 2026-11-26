# Microsoft 365 connector: investigation

What a Microsoft 365 connector would take, read against the code in
`core/switch_core/connections/` (at `a6c98762`), Microsoft's documentation,
and Microsoft's live endpoints as they answered on 26 November 2026. Without
a tenant, nothing here signed in. Every claim is marked **measured** (tried
against a live endpoint on that date, with no account) or **documented**
(read in Microsoft's own pages, each linked below). What only a tenant with
Work IQ billing can settle is listed at the end.

This is the investigation the issue asks for, narrowed by the maintainers to
a report plus an optional disabled draft entry. The draft entry is in
`catalog/microsoft-365/connection.yaml`; it stays `enabled: false`, has no
identity block and no skill, and changes nothing at runtime.

## What changed since the issue was written

The issue describes Work IQ as a preview with unclear licensing. Both have
since settled:

- **Work IQ is generally available since 16 June 2026** (Microsoft's
  announcement). Only the MCP server's `retrieve` tool is still in public
  preview (its overview page says so today).
- **Licensing is settled.** The Copilot Credits Guide (November 2026,
  pages 24-25) prices Work IQ APIs exactly; see below.
- **The Graph CLI alternative is gone.** `msgraph-cli` was deprecated on
  1 September 2025 and retired on 28 August 2026. Measured: its repository
  is archived, last push 2025-08-29.
- **A Work IQ CLI exists and is itself GA.** Measured: `@microsoft/workiq`
  1.0.1 on npm, published 2026-09-24. It is examined below; the issue's
  shape 2 question has to consider it, and it does not fit.

## Recommendation

Build on **Work IQ's remote MCP server** — shape 1, `adapter: oauth` with
`mcp` — with a static multitenant Entra client and a **read-only** level
(`WorkIQ.Read`). Ship it only after three small, vendor-neutral Core changes
and one tenant-backed test pass:

1. **An identity mode that reads the ID token's claims** (`tid` + `oid`),
   because no URL, MCP tool or introspection endpoint can name a Work IQ
   account (below). The maintainers asked for this report before that mode
   is built; the case for it is made here.
2. **Protocol scopes kept out of the consent comparison**, because Entra's
   token response does not count `openid`, `profile` or `offline_access`
   among the granted scopes it echoes.
3. **A way to keep the RFC 8707 `resource` parameter with named OAuth
   endpoints**, because discovery cannot serve Entra and named endpoints
   silently drop the resource binding Work IQ declares.

Microsoft Graph fits none of the three connector shapes without new broker
code, which the issue reserves for a comment first. It stays the fallback
if Copilot Credits pricing rules Work IQ out.

## Work IQ versus Microsoft Graph

| | Work IQ remote MCP | Microsoft Graph |
| --- | --- | --- |
| Reaches | Outlook mail and calendar, OneDrive and SharePoint files, Teams messages, people, Planner (**documented**) | The same, and more |
| Tool surface | One remote MCP server, 12 generic tools over Graph-shaped paths (**documented**, tool list below) | REST only: no vendor MCP server for these workloads, and no maintained vendor CLI (measured, below) |
| Permissions | Three coarse delegated scopes: `WorkIQ.Read`, `WorkIQ.Act`, `WorkIQAgent.Ask` (**documented**, identifiers measured below) | Fine-grained (`Mail.Read`, `Files.Read`, …) |
| Consent | Admin consent for every scope (**documented**) | Many scopes are user-consentable |
| Cost | Copilot Credits on every call (**documented**, priced below) | None beyond the Microsoft 365 licence |
| Identity | No endpoint accepts its token (below) | `GET /v1.0/me` fits today's `identity.url` mode |
| Writes | Blocked by tenant policy by default, tenant-wide (below) | Per scope |
| Status | GA since 2026-06-16; `retrieve` tool in preview (**documented**, retrieved today) | GA |

Work IQ's twelve tools (**documented**, MCP overview and tool reference):
`fetch`, `fetch_blob`, `create_entity`, `update_entity`, `delete_entity`,
`do_action`, `call_function`, `ask`, `retrieve`, `list_agents`,
`get_schema`, `search_paths`. The entity tools take Graph-shaped relative
paths (`fetch /me/messages`, `do_action /me/sendMail`), so an agent works
much as it would against Graph. They pass through unclassified, as
Atlassian's do, and the tenant's policy decides what a path may do.

Graph's route has nothing to point an entry at:

- **Microsoft Graph CLI** (`msgraph-cli`): retired. Measured: the
  repository is archived; Microsoft's retirement post dates full
  retirement 2026-08-28. A connector pins the vendor's own maintained
  release; this is no longer one.
- **Microsoft Graph PowerShell SDK**, which Microsoft names as the CLI's
  successor: a PowerShell runtime plus modules, not one pinned binary run
  without a shell.
- **CLI for Microsoft 365**: a PnP community project distributed through
  npm, not Microsoft's pinned release.
- **Microsoft MCP Server for Enterprise** (preview): read-only, Entra
  identity and directory data only — no mail, files or Teams. Measured
  2026-11-26: `POST https://mcp.svc.cloud.microsoft/enterprise` answers
  401 with a challenge naming its own protected-resource metadata, the
  same shape as Work IQ's.

So Graph means writing an MCP server or proxy in Switch. The issue asks
for a comment before broker code; that is the main reason Work IQ comes
first.

## The Work IQ surfaces, measured on 26 November 2026

### The remote MCP server

- `POST https://workiq.svc.cloud.microsoft/mcp` with no token answers
  **401** whose `WWW-Authenticate` header names the path-specific
  protected-resource metadata
  (`resource_metadata="https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp"`).
  The same header's `authorization_uri` is the **v1**
  `https://login.microsoftonline.com/common/oauth2/authorize`, while the
  metadata it points to names the **v2** `organizations` issuer — a
  discrepancy in Microsoft's own hints. Switch's discovery follows the
  metadata, not the hint (`OAuthAdapter._find_endpoints`), so it lands on
  the v2 `organizations` authority, which is the right one for work
  accounts.
- The metadata itself answers 200: resource
  `https://workiq.svc.cloud.microsoft/mcp`, authorization server
  `https://login.microsoftonline.com/organizations/v2.0`, one advertised
  scope, `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` (the
  first-party application id form; the permissions page writes the same
  permission as `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask`), bearer
  in the header only. Since an earlier capture on 2026-11-06 the document
  has gained a field (`openai_apps_challenge`): the metadata is live and
  drifting, which is why the entry's values should be measured again
  before enablement. The root well-known address answers 400, so the
  path-specific address matters; Switch's fallback order already tries it
  first.
- A made-up token answers **401** `InvalidAuthenticationToken` ("the token
  could not be read"): the resource validates tokens itself.
- The issuer's OIDC configuration answers at only one of the three
  addresses Switch tries (the third,
  `…/organizations/v2.0/.well-known/openid-configuration`; the first two
  answer 404 — measured). It lists **no** `code_challenge_methods_supported`,
  **no** `registration_endpoint`, **no** `revocation_endpoint` and **no**
  `introspection_endpoint`; its `userinfo_endpoint` is
  `https://graph.microsoft.com/oidc/userinfo`, a Graph resource; its
  `scopes_supported` is only `openid`, `profile`, `email`,
  `offline_access`; its issuer is the template
  `https://login.microsoftonline.com/{tenantid}/v2.0`. The `common` and
  `consumers` documents carry the same absences (measured). Entra serves
  no RFC 8414 authorization-server metadata at all (404, measured).

### The OAuth endpoints, probed without an account

- `POST …/oauth2/v2.0/token` with a made-up code and a client id that does
  not exist answers `invalid_grant` (AADSTS9002313) — **identically with
  and without an RFC 8707 `resource` parameter**. Two readings: the token
  endpoint accepts the parameter's shape (it does not answer
  `invalid_request`), and it judges the code before the client, so
  Switch's static-client check, which reads `invalid_grant` as "client id
  and secret are right" (`app_checks.py`), passes any client. The draft
  entry therefore says `unchecked`.
- `GET …/oauth2/v2.0/authorize` with a well-formed but nonexistent client
  id renders the sign-in page rather than an application error, both with
  and without `resource`: Entra defers application validation past
  authentication, so whether the authorize request may carry `resource`
  is not observable without a real sign-in. (It does validate PKCE up
  front: a malformed `code_challenge` answers AADSTS501491.)
- **Documented:** Entra's v2.0 endpoint takes a token's audience from the
  scope's resource prefix, so a token asked for with
  `api://workiq.svc.cloud.microsoft/…` scopes is a Work IQ token whether
  or not `resource` rides along. Whether Work IQ insists on the indicator
  the MCP authorization spec requires is a tenant question.

### The Work IQ CLI

Measured: `@microsoft/workiq` on npm, latest 1.0.1 (2026-09-24), `bin`
`workiq.js`, `engines` Node ≥ 16, a per-version sha512 integrity hash; GA
since 2026-06-16 per its documentation, which drops support for the
pre-GA 0.x builds. Its sign-in is its own: it takes a `--tenant-id`
(default `common`) and works against Microsoft's first-party Work IQ
application, which each tenant's administrator consents to; billing is
the tenant's Copilot Credits plan.

It does not fit shape 2, for the same class of reasons as the PowerShell
SDK: Switch's CLI shape pins one vendor binary per platform by SHA-256
and runs it without a shell, while `workiq` is a Node package needing a
runtime; and its sign-in belongs to the CLI against Microsoft's own
client, not to a client Switch's operator registers, so a Switch
connection could neither drive its OAuth nor read its identity. It is a
tool for a developer's own tenant, not a connector surface for a server.

## Licensing and Copilot Credits

From the Copilot Credits Guide, November 2026, pages 24-25 (**documented**,
re-read today):

- "Work IQ APIs are not included as entitlements in the Microsoft Copilot
  license." No licence covers them; every call is billed in Copilot
  Credits, including for Copilot-licensed users.
- Tools-API calls (`fetch`, `create_entity`, `do_action` and the like):
  a static **0.1 credits per call**. Chat/context calls (`ask`,
  `retrieve`): variable, "driven by models, runtime, context, and tools";
  Microsoft's illustrative tasks cost 15-30 credits (light), 30-60
  (medium), 60-100 (heavy).
- Prerequisites: Work IQ enabled for the tenant (a one-time Global
  Administrator step: creating Work IQ's service principal,
  `fdcc1f02-fc51-4226-8753-f668596af7f7`) **and** Copilot Credits
  usage-based billing: a plan in Copilot Studio linked to an Azure
  subscription and resource group, with the user assigned to the plan.

**Who pays:** the connecting tenant, for every call an agent makes. A
chat-flavoured task costs roughly a hundred times a direct read, so the
skill must steer agents to `fetch` and `search_paths` over `ask` and
`retrieve` where a direct read will do — the same warning Atlassian's
entry gives for Rovo credits, but here it applies to every call.

**Who can test:** the Microsoft 365 Developer Program's free E5 sandbox is
limited to Visual Studio subscribers, eligible partner programs, and
Premier/Unified support customers (its FAQ, retrieved today), and even a
sandbox carries no Work IQ entitlement: the Copilot Credits billing plan
is paid. A hackathon-scale account cannot exercise this API, which is
consistent with the maintainers not providing a tenant.

## Write policy

**Documented** (Work IQ MCP policy and governance): "By default, mutation
operations aren't allowed for safety." Mutations are create, update,
delete and action requests; an administrator allows them in the Microsoft
365 admin center; the policy is tenant-wide — per-user, per-app and
per-agent policy are not in the first release — and a change can take up
to 24 hours to apply. (Copilot Studio's own Work IQ page says writes are
on by default, but that page covers Copilot Studio's agents, not the MCP
server.) The user's own permissions still bound everything.

So tenant policy cannot be Switch's read-only boundary: once an
administrator allows writes, every app may write. What Switch controls is
the scope it asks for. The permissions reference (**documented**;
identifiers measured from the live page today) lists exactly three
delegated permissions, all admin-consent-required:

| Permission | Identifier | Reaches |
| --- | --- | --- |
| `WorkIQ.Read` | `c3c950a1-c6dc-4f63-9765-f363f1fab462` | read what the user can access |
| `WorkIQ.Act` | `54b3dd6b-e697-4e6a-8fcd-96af0b25009d` | read and change |
| `WorkIQAgent.Ask` | `0b1715fd-f4bf-4c63-b16d-5be31f9847c2` | ask Work IQ agents, "including read and write access" |

The draft entry's read level asks for `WorkIQ.Read`. The catch, measured:
the server's own protected-resource metadata advertises only
`WorkIQAgent.Ask`. Whether the endpoint accepts a `WorkIQ.Read` token —
and, with tenant policy permitting writes, whether that token is refused
mutations — is the first thing a tenant run must settle. If the endpoint
accepts only `Ask`, there is no read-only level to offer, and the choice
becomes a maintainer decision: ask for `Ask` and let tenant policy be the
only write boundary, or wait for the permission model to widen.

## Identity

Switch reads an account with an authenticated GET of the entry's
`identity.url`, from an MCP tool (`identity.mcp_tool`, the Sentry
precedent), or through introspection — exactly one of the three
(`loader.py`). For Work IQ, all three fail:

- **url.** Entra issues an access token for one resource, and a Work IQ
  token's audience is Work IQ (**documented**), so Graph's `/me` and
  Entra's advertised `userinfo_endpoint` — itself a Graph URL, measured —
  refuse it. Work IQ documents no profile GET; its tools take paths, not
  a "who am I" address.
- **mcp_tool.** Work IQ's twelve tools (**documented**) include no
  identity tool.
- **introspection.** The metadata names no introspection endpoint
  (measured).

What would work, and is the smallest Core change: **read the ID token's
claims.** With `openid profile` in the request, the same token response
carries an `id_token` whose `oid` (the user's object id) and `tid` (their
tenant) are a stable account key and whose `preferred_username` is a
label people recognise (**documented**; the measured metadata lists all
three claims, plus `nonce`, in `claims_supported`). Before Core stores
`tid`/`oid` as the account it must validate the token it just received:
signature against the tenant's JWKS (the measured `jwks_uri`), `aud`
equal to the client's id, `exp`/`nbf` in range, `iss` equal to
`https://login.microsoftonline.com/{tid}/v2.0` for the token's own `tid`
(the `organizations` authority accepts any tenant, so there is no single
issuer string to compare with), and the flow's `nonce` if one was sent.
This mode is vendor-neutral: any OIDC sign-in could use it, and the
maintainers asked to see this report before it is built.

The alternatives are worse: redeeming the refresh token for a Graph
`User.Read` token to call `/me` adds consent, a second token and its
lifecycle; asking Work IQ itself (`fetch /me`) spends Copilot Credits on
every identity read and puts identity behind the MCP session. One
property comes free and is worth keeping: `organizations` excludes
personal Microsoft accounts, and a guest in another tenant carries that
tenant's `tid`, so `tid:oid` never merges two tenants' accounts.

## What Switch would need

What fits today's catalog, and is in the draft entry:

- **A static client** (`registration: static`, `client_settings:
  MICROSOFT_365`): measured, Entra has no dynamic registration. The
  operator registers one multitenant application
  (`AzureADMultipleOrgs`, web platform, a client secret); each connecting
  tenant's administrator grants consent once.
- **`redirect: [core]`.** Core's callback is an exact https address.
  Console's loopback listener is `http://127.0.0.1:<port>/…`, and
  Microsoft documents ignoring the port only for `localhost` redirect
  URIs; whether `127.0.0.1` is treated the same is undocumented, so
  `loopback` waits on a tenant measurement.
- **Named endpoints, not discovery.** Measured: discovery would follow
  Work IQ's 401 to its metadata, then to `organizations/v2.0`, and find
  the OIDC document at the third address it tries — which lacks
  `code_challenge_methods_supported`, so `OAuthAdapter.endpoints`
  refuses it, though Entra takes S256. Named endpoints skip discovery but
  send no `resource` (`resource=None` in the named branch), which the MCP
  authorization spec requires. See Core change 3.
- **`unchecked`.** Measured: Entra answers a made-up code with
  `invalid_grant` even for a client that does not exist, so the client
  check passes any client.
- **`remove_access`.** Measured: no revocation endpoint exists; and a
  person cannot revoke what an administrator consented to, so only the
  tenant's administrator can remove Switch. Disconnect stops Switch's own
  use and says so.
- **`refresh: reusable`** (**documented**: a refresh returns a new refresh
  token without revoking the old) and **`max_lifetime: 5400`**
  (**documented**, 60-90 minutes by default; not measured, and tenants
  can set longer — the broker holds a passed-through token to this cap).
- **`prompt: select_account`.**

What needs Core changes, none of them Microsoft-specific:

1. **The ID-token identity mode** above.
2. **Protocol scopes kept out of the consent comparison.**
   `ServiceFlows.consent` requires every scope of a level to appear in
   the sign-in's granted scopes; `OAuthAdapter` reads those from the
   token response's `scope`, falling back to the requested list when the
   field is absent. Entra documents `scope` as the access token's scopes
   and issues a refresh token only when `offline_access` was requested —
   so if the field is echoed without the protocol scopes, today's
   comparison judges the level not granted and asks to reconnect, and if
   it is omitted, the fallback passes either way. Which of the two Work
   IQ sign-ins do is unmeasured; both outcomes are wrong today for
   different reasons. Compare level scopes against the granted scopes
   minus `openid`, `profile`, `email` and `offline_access` instead.
3. **A `resource` kept with named endpoints.** The MCP authorization spec
   makes the indicator mandatory and Work IQ's metadata declares one;
   measured, Entra's token endpoint at least tolerates it; documented,
   Entra takes the audience from the scope prefix regardless. An optional
   `resource_url` beside `authorization_url`/`token_url` would send it.
   GitLab's entry names endpoints for the mirror-image reason (its token
   must *not* be bound to the MCP resource), so the field must stay
   opt-in.

## The draft entry

`catalog/microsoft-365/connection.yaml` is the entry above, disabled,
with each choice commented as measured or documented. It has no
`identity` (the loader requires one only of enabled entries), no write
level, and no skill, since a disabled entry ships none. The registry and
the Connector apps page skip disabled entries, so it changes nothing at
runtime; `test_loader.py` pins its values and no longer counts it as a
placeholder.

## What a tenant run must settle

In order, in a tenant with Work IQ enabled and billing on synthetic data:

1. Does the MCP endpoint accept a `WorkIQ.Read` token, or only
   `WorkIQAgent.Ask`, as its metadata advertises? And in the GUID-prefixed
   or `api://`-prefixed scope spelling?
2. With tenant policy allowing writes, is a `WorkIQ.Read` token refused
   `create_entity`, `update_entity`, `delete_entity`, `do_action`,
   `call_function` and `ask`-mediated writes?
3. What does the token response's `scope` contain, exactly — present or
   absent, which prefix form, and are the protocol scopes echoed?
4. Access-token lifetime, measured; Continuous Access Evaluation and
   tenant-configured lifetimes against the entry's `max_lifetime`.
5. The ID token's actual claims (`oid`, `tid`, `preferred_username`) and
   issuer for a multitenant client.
6. Whether Work IQ requires, and Entra honors, the `resource` parameter
   on the real authorization and token requests.
7. Whether Entra ignores the port of an `http://127.0.0.1` redirect URI,
   which would let `loopback` join the entry's redirect modes.
8. The credits a typical agent task spends, `fetch` versus `ask`, and how
   a call fails when billing is off or exhausted.
9. `tools/list` and `get_schema` with a real token; per-path availability
   of mail, calendar, OneDrive, SharePoint and Teams; blob and collection
   size limits; nested per-path errors under a 200.
10. The acceptance walk: connect, grant to an agent, use the tools in a
    room, token visible nowhere, grant off stops the session within a
    minute, disconnect.

## Sources

Live probes, 26 November 2026, all unauthenticated: `POST` and token
probes against `https://workiq.svc.cloud.microsoft/mcp` and
`https://mcp.svc.cloud.microsoft/enterprise`; `GET` of both hosts'
protected-resource metadata (path-specific and root); `GET` of the OIDC
documents for `organizations`, `common` and `consumers`, of the RFC 8414
addresses, and of the three discovery candidates in Switch's order;
`POST` of made-up code exchanges, with and without `resource`, to the
`organizations` v2.0 token endpoint; `GET` of the authorize endpoint with
a nonexistent client id; `GET` of `https://graph.microsoft.com/v1.0/me`
and `/oidc/userinfo` with a bad token; the npm registry record for
`@microsoft/workiq`; the GitHub API record for
`microsoftgraph/msgraph-cli`.

Documents, each re-read on 26 November 2026:

- [Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview) and [tool reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference)
- [Work IQ API permissions reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)
- [Work IQ MCP policy and governance](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp)
- [Enable your tenant for Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Microsoft Work IQ CLI](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli)
- [Copilot Credits Guide, November 2026](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/ai/CopilotCreditsGuide.pdf), pages 24-25
- [Work IQ API GA announcement, June 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-june#work-iq-api-and-consumptive-pricing-update)
- [Microsoft 365 Developer Program FAQ](https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq)
- [Microsoft MCP Server for Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview)
- [Microsoft Graph CLI retirement](https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-cli-retirement/) and its [archived repository](https://github.com/microsoftgraph/msgraph-cli)
- [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference), [access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), [refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens), [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [MCP authorization, resource parameter](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
