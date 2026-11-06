# Microsoft 365 connector: investigation

What a Microsoft 365 connector would take, read against the code in
`core/switch_core/connections/`, Microsoft's documentation, and Microsoft's live
endpoints as they answered on 6 November 2026. Without a tenant, nothing here
signed in. Where a fact was measured rather than read, it says so. The open
points that only a tenant can settle are listed at the end.

## Recommendation

Use **Work IQ's remote MCP server** (shape 1: `adapter: oauth` with `mcp`),
with a static client and a **read-only** level. Ship it only after two changes
to Core, neither specific to Microsoft:

1. **An identity read from the ID token** (`oid` and `tid`), because no
   endpoint will tell Switch who a Work IQ token belongs to.
2. **Scopes requested but not compared.** `offline_access` must be requested
   to get a refresh token, but Entra's token response does not list it, so
   Switch's consent check would judge every sign-in not granted.

Microsoft Graph fits none of the three connector shapes without new broker
code. It is the fallback if Copilot Credits rule Work IQ out.

The draft entry in `catalog/microsoft-365/connection.yaml` follows this
recommendation. It stays `enabled: false`, has no `identity` block, and the
loader tests pin its values.

## Work IQ versus Microsoft Graph

| | Work IQ MCP | Microsoft Graph |
| --- | --- | --- |
| Reaches | Mail, calendar, OneDrive and SharePoint files, Teams messages, people, Planner | The same, and more |
| Tool surface | Remote MCP server, `https://workiq.svc.cloud.microsoft/mcp` | REST only. No vendor MCP server for these workloads, and no maintained vendor CLI |
| Scopes | Coarse: `WorkIQ.Read`, `WorkIQ.Act`, `WorkIQAgent.Ask` | Fine-grained (`Mail.Read`, `Calendars.Read`, `Files.Read.All`, …) |
| Consent | Admin consent for every scope | Many scopes are user-consentable |
| Cost | Copilot Credits per call (below) | None beyond the Microsoft 365 licence |
| Identity | No endpoint accepts its token (below) | `GET /v1.0/me` works with today's identity mode |
| Writes | Blocked by default, tenant-wide (below) | Per scope |
| Status | MCP `retrieve` tool in public preview | GA |

Work IQ's tools, from Microsoft's MCP overview: `fetch`, `fetch_blob`,
`create_entity`, `update_entity`, `delete_entity`, `do_action`,
`call_function`, `ask`, `retrieve`, `list_agents`, `get_schema` and
`search_paths`. The entity tools take Graph-shaped paths (`/me/events`,
`/me/sendMail`), so the agent works much as it would against Graph. They pass
through unclassified, as Atlassian's do. Microsoft also ships a Work IQ CLI
that runs as a local MCP server (`workiq mcp`). Its sign-in was not examined
here; the remote server needs no binary on the session host.

Graph's route has no tool surface to point an entry at:

- **Microsoft Graph CLI** (`msgraph-cli`) was deprecated on 1 September 2025
  and retired on 28 August 2026. Its repository is archived. A connector must
  pin the vendor's own release, and this one is no longer maintained.
- **CLI for Microsoft 365** is a PnP community project, not Microsoft's
  release, and ships through npm, not as a pinned binary.
- **Microsoft Graph PowerShell SDK**, which Microsoft names as the CLI's
  replacement, needs a PowerShell runtime and its modules, not one pinned
  binary.
- **Microsoft MCP Server for Enterprise**
  (`https://mcp.svc.cloud.microsoft/enterprise`, preview) is read-only and
  limited to Entra identity and directory data. It cannot read mail or files.

So Graph means writing an MCP server or proxy in Switch. The issue asks for a
comment before any broker code is written. That is the main reason Work IQ
comes first.

## Licensing and Copilot Credits

From Microsoft's Copilot Credits Guide (November 2026, pages 13-14):

- **No Copilot licence needed, and none helps:** "Work IQ APIs are not
  included as entitlements in the Microsoft Copilot license." Every call is
  billed in Copilot Credits.
- **Tools calls** (`fetch`, `create_entity`, `do_action` and the like): a
  static 0.1 Copilot Credits per call.
- **Chat and context calls** (`ask`, `retrieve`): variable, "driven by
  models, runtime, context, and tools". Microsoft's illustrative tasks cost
  15-30 credits (light), 30-60 (medium) and 60-100 (heavy).
- **Prerequisites:** Work IQ enabled for the tenant, and Copilot Credits
  usage-based billing enabled. Billing is set up under Copilot, Cost management
  in the Microsoft 365 admin center (pay-as-you-go, a pre-purchase plan or
  prepaid capacity packs), with an Azure subscription and resource group.

Enabling Work IQ is a one-time step by a Global Administrator: creating Work
IQ's service principal in the tenant (`az ad sp create --id
fdcc1f02-fc51-4226-8753-f668596af7f7`, Microsoft's own app id).

**Who pays:** the customer's tenant, for every call an agent makes. Atlassian's
entry already warns about Rovo credits for a few tools; here it is every call,
and a chat or context task is estimated at 15-100 credits against 0.1 for a
tools call. The skill must say so, and
should steer agents to `fetch` and `search_paths` over `ask` and `retrieve`
where a direct read will do.

## Write policy

Microsoft's Work IQ MCP policy page settles it: "By default, mutation
operations aren't allowed for safety." Mutations are create, update, delete
and action requests. An administrator allows them in the Microsoft 365 admin
center (Agents, Tools, Work IQ MCP, Policy). The policy applies across the
tenant: per-user, per-app and per-agent policy are not in the first release.
A change can take up to 24 hours to apply. (Copilot Studio's own Work IQ page
says write operations are on by default. That page covers Copilot Studio's
agents, not the MCP server.)

So Switch cannot offer read and write levels through the tenant policy: once
an admin allows writes, they are allowed for every app. What Switch controls
is the scope it asks for:

- `WorkIQ.Read` reads, and `WorkIQ.Act` acts, per the permissions page. The
  draft offers only a read level, with `WorkIQ.Read`.
- `WorkIQAgent.Ask`, the only scope the live server advertises in its
  protected-resource metadata, "includes read and write access to Microsoft
  365 resources", per the same page. Asking for it would give up the
  read-only level.

The MCP overview speaks of "four broad OAuth permissions" without naming
them, and the permissions page lists three. Whether the MCP endpoint accepts a
`WorkIQ.Read` token, and whether that token is refused writes once the policy
allows them, is unverified.

## Identity

Switch reads an account with a `GET` of the entry's `identity.url`, using the
connection's own access token (`ConnectionIdentity`,
`OAuthAdapter.identify`). For Work IQ, no such URL exists:

- Entra issues an access token for one resource. A Work IQ token's audience is
  Work IQ, so Graph's `/me` refuses it.
- Entra's advertised `userinfo_endpoint` is
  `https://graph.microsoft.com/oidc/userinfo`, which is a Graph resource and
  refuses it too.
- Work IQ documents no "who am I" call, and its tools take paths, not a
  profile endpoint.

What would work, in order of preference:

1. **The ID token's claims.** With `openid profile` in the request, the same
   token response carries an `id_token` with `oid` (the user's object id),
   `tid` (their tenant) and `preferred_username` (a label people recognise,
   which can change). Both `oid` and `preferred_username` need the `profile`
   scope. Since the token comes straight from the token endpoint over TLS,
   OpenID Connect Core §3.1.3.7 allows TLS server validation instead of
   checking its signature. That waives only the signature: before it stores
   `oid` and `tid` as the account, Core must still check that `aud` is this
   client's id, that `exp` has not passed, that `iss` is
   `https://login.microsoftonline.com/{tid}/v2.0` for the token's own `tid`
   (the `organizations` authority accepts any tenant, so there is no single
   issuer to compare with), and that `nonce` matches the sign-in's, if one was
   sent. Core needs an identity mode that reads named claims from the ID token,
   after those checks, instead of calling a URL. This is the mode the maintainers
   asked to see a report before building.
2. **A second token for Graph.** Entra's refresh tokens are valid for every
   permission the client has consent for, so Core could redeem the refresh
   token for `User.Read` and call `/v1.0/me`. A refresh may only ask for scopes
   the sign-in asked for, so `User.Read` joins the sign-in, and Core handles
   two tokens. More code and more consent than option 1.
3. **Asking Work IQ itself** (`fetch /me`). Each call spends Copilot Credits,
   and it puts identity behind the MCP session. Not recommended.

Every Work IQ sign-in is against one work tenant. The draft uses the
`organizations` authority, which keeps personal Microsoft accounts out. A
multitenant app (`AzureADMultipleOrgs`) needs no tenant field in the entry.
Each customer tenant's admin grants consent once.

## What Switch would need

What fits today's catalog, and is in the draft entry:

- **Named endpoints, not discovery.** Measured: discovery follows Work IQ's 401
  to its metadata, then to `https://login.microsoftonline.com/organizations/v2.0`,
  and finds Entra's OpenID configuration on the third address it tries (the
  first two answer 404). That document has no
  `code_challenge_methods_supported`, so `OAuthAdapter.endpoints` refuses it
  ("does not offer PKCE with S256"), though Entra takes S256. Its issuer is
  also the template `https://login.microsoftonline.com/{tenantid}/v2.0`. Named
  endpoints skip discovery, but they also send no RFC 8707 `resource`, which
  the MCP authorization spec says clients must send. Entra's v2.0 endpoint
  takes a token's audience from the scope's prefix
  (`api://workiq.svc.cloud.microsoft/…`), so the audience is Work IQ's either
  way. Microsoft does not say whether v2.0 accepts `resource`, and a probe
  without a real client stops at an earlier error (AADSTS50059). If Work IQ or
  Entra needs it, Core needs a way to keep `resource` with named endpoints.
- **A static client** (`registration: static`, `client_settings:
  MICROSOFT_365`): the metadata has no `registration_endpoint`.
- **`unchecked`.** Switch checks a static client by redeeming a made-up code
  (`check_oauth_client`). Measured: Entra answered `invalid_grant`
  (AADSTS9002313) for a client id that does not exist, so it rejects the code
  before it looks at the client, and the check passes any client.
- **`remove_access`.** Entra has no revocation endpoint, so disconnecting
  cannot revoke at Microsoft. Every Work IQ permission is admin-consented, and
  people cannot revoke what an admin consented to, so only the tenant's admin
  can remove Switch.
- **`refresh: reusable`.** Entra returns a new refresh token with each refresh
  and says to discard the old one, but does not revoke it.
- **`max_lifetime: 5400`.** Access tokens last a random 60-90 minutes by
  default, per Microsoft. Not measured, and Microsoft documents longer ones
  (below).
- **`redirect: [core]`.** Entra ignores the port of a `localhost` redirect URI
  but recommends `127.0.0.1`, for which the port is not ignored, so loopback
  needs measuring first.

What needs Core changes:

- **The identity mode** described above.
- **Scopes requested but not compared.** `ServiceFlows.consent` requires every
  scope of a level to be in the token response's `scope`. Entra documents that
  field as "the scopes that the access_token is valid for", and returns a
  refresh token "only … if offline_access scope was requested". So asking for
  `offline_access` (and `openid profile`) breaks the comparison, and leaving
  them out means no refresh token. Atlassian's `offline_access` works only
  because Atlassian echoes it.

## The draft entry

`catalog/microsoft-365/connection.yaml` is the entry above, disabled, with
comments on each choice. It has no `identity` (the loader allows that only in a
disabled entry), no write level, and no skill, since a disabled entry ships
none. The registry and the Connector apps page skip disabled entries, so it
changes nothing at runtime. `test_loader.py` pins its endpoints, client,
server, missing identity and read scopes, and no longer counts it as a
placeholder.

## What a tenant run must settle

1. Does the MCP endpoint accept a token with `WorkIQ.Read`, or only
   `WorkIQAgent.Ask`, as its metadata advertises?
2. With writes allowed by the tenant policy, is a `WorkIQ.Read` token refused
   them?
3. What does the token response's `scope` contain, exactly (short or full
   names, `offline_access` or not)?
4. Access token lifetime, measured. Microsoft documents two-hour defaults for
   some clients, 20-28 hours under Continuous Access Evaluation, and
   tenant-configured lifetimes, and the broker holds back a token that
   outlives `max_lifetime`.
5. The credits a typical agent task spends, through `fetch` versus `ask`.
6. Whether Switch Console's loopback sign-in works with a Web-platform Entra
   app, which would let Microsoft 365 connect like Atlassian.
7. Whether Entra's v2.0 endpoint accepts an RFC 8707 `resource` beside the
   scopes, and whether Work IQ accepts a token requested without one.

## Sources

- Live probes, 6 November 2026: `POST https://workiq.svc.cloud.microsoft/mcp`
  with no token (401, `resource_metadata` named), its protected-resource
  metadata, the three discovery addresses for Entra's `organizations/v2.0`
  metadata, and a made-up-code redemption at Entra's token endpoint with a
  client id that does not exist.
- [Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview)
- [Work IQ MCP policy and governance](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp)
- [Work IQ API overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview)
- [Work IQ permissions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)
- [Enable Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Work IQ in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/add-work-iq)
- [Copilot Credits Guide, November 2026](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/ai/CopilotCreditsGuide.pdf), pages 13-14
- [Usage-based billing with Copilot Credits](https://learn.microsoft.com/en-us/copilot/plan/usage-based-billing-overview-copilot-credits)
- [Microsoft MCP Server for Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview)
- [Microsoft Graph CLI retirement](https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-cli-retirement/) and its [archived repository](https://github.com/microsoftgraph/msgraph-cli)
- [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
- [Scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)
- [MCP authorization, resource parameter](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)
- [Redirect URI restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [OpenID Connect Core 1.0, §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
