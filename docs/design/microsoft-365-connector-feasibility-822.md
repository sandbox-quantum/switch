# Microsoft 365 connector feasibility (#822)

As of **2026-11-07**, against Switch
`d51a31c1fcfaab94f6f7289f8099847d47343d72`. This is the investigation
[requested by the maintainer][scope], not a connector implementation. No tenant,
application credentials or authenticated Microsoft 365 data were available.

## A. Executive decision

**Defer enablement; prefer Work IQ remote MCP for the next approved experiment.**
It supplies the requested workloads through an existing Switch transport shape.
Graph offers narrower delegated permissions but still needs a reviewed transport
for those workloads. Neither route is currently a catalog-only implementation.

Keep the existing `microsoft-365` placeholder unchanged and disabled. Before an
implementation, maintainers need to approve identity and consent handling, settle
the explicit-endpoint/resource-indicator conflict, and obtain a consented tenant
with billing. Before enablement, every applicable gate in section F must pass.
If the endpoint cannot enforce a read-only permission, return for an access-model
decision; do not silently substitute write-capable `WorkIQAgent.Ask`.

## B. Work IQ versus Microsoft Graph

| Concern | Work IQ remote MCP | Microsoft Graph |
| --- | --- | --- |
| Outlook mail/calendar | Documented through resource-path tools, including `/me/messages` and `/me/events`. | REST endpoints with workload-specific delegated permissions, such as `Mail.Read` and `Calendars.Read`. |
| OneDrive/SharePoint | Documented file/entity reads; actual paths and tenant availability need testing. | REST file/site endpoints. Start with `Files.Read` for the user's files; justify wider site access separately. |
| Teams | Documented message access; verify chats and channels separately rather than infer complete coverage. | Separate chat/channel APIs, for example `Chat.Read` versus `ChannelMessage.Read.All`; consent requirements differ. |
| Transport fit | Official HTTPS MCP resource; fits OAuth plus `mcp` in principle. | REST/SDK is not a catalog transport. The official Enterprise MCP preview currently targets directory reads, not these productivity workloads. |
| Authorization | Delegated Entra permissions plus user access and mutable tenant policy. | Delegated Graph permissions plus user access; app-only permissions are a different, broader model. |
| Operation/safety | Generic path-based reads, mutations and Copilot tools; tool discovery does not prove authorization. | Narrower operation scopes; an approved transport would still need bounded paths, methods and response handling. |
| Cost/deployment | Work IQ billing and tenant/user enablement, static app consent, unresolved identity. | Workload entitlements and any API-specific metering still apply; not a claim that every Graph operation is free. |

Workload and permission evidence: [Work IQ API][api], [tool reference][tools],
[Graph permissions][graph-perms], [Graph authorization][graph-auth],
[Enterprise MCP scope][enterprise]. These are documented capabilities, not tested
coverage in Switch.

The three Microsoft command-line products are different:

- **Microsoft Graph CLI (`mgc`):** Microsoft's retirement notice schedules full
  retirement for 2026-08-28. Do not select it for a new supported connector.
  [Retirement notice, 2025-08-29][graph-cli]
- **Microsoft Graph PowerShell SDK:** maintained modules with delegated sign-in
  and `Connect-MgGraph -AccessToken`; not a drop-in pinned workload binary.
  A host-only wrapper would need separate approval, fixed operations, controlled
  module loading and no agent-supplied scripts. [Authentication documentation][ps]
- **Microsoft Work IQ CLI:** official Node/npm client with `workiq ask` and
  `workiq mcp` (stdio), EULA acceptance and tenant consent/billing prerequisites.
  Its documented setup does not establish Switch's broker-token input contract,
  pinned executable distribution or a catalog HTTP transport. It is not a Graph
  CLI fallback, and copying its `npx` configuration would not satisfy the
  [existing connector rules][shapes]. [CLI documentation][iq-cli]

## C. OAuth and identity compatibility

### Public observations

Anonymous GETs on 2026-11-07 returned:

| Request | Observed result |
| --- | --- |
| `https://workiq.svc.cloud.microsoft/mcp` | HTTP 401; challenge names the path-specific resource metadata below. |
| `https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp` | HTTP 200; resource `https://workiq.svc.cloud.microsoft/mcp`; authorization server `https://login.microsoftonline.com/organizations/v2.0`; scope `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask`. |
| `https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration` | HTTP 200; organizations authorize/token URLs; templated tenant issuer; Graph UserInfo; no advertised S256 methods, registration endpoint or revocation endpoint. |

Only stable public metadata is recorded. No transient challenge, account or
tenant identifiers were captured. Missing advertised fields establish neither
unsupported PKCE nor the absence of every possible revocation mechanism.

### Scope, resource and consent are separate gates

[Microsoft's permissions reference][permissions] (updated 2026-10-30) lists
delegated, admin-consented `WorkIQ.Read`, `WorkIQ.Act` and `WorkIQAgent.Ask`.
The documented scope prefix is `api://workiq.svc.cloud.microsoft/`; `Ask`
includes writes. Public metadata instead advertises the GUID-prefixed `Ask`.
The [MCP overview][overview] mentions four broad permissions without enumerating
four in that reference. These surfaces do not prove which permission each MCP
tool accepts. Test `api://workiq.svc.cloud.microsoft/WorkIQ.Read` first; do not
invent the fourth scope or assume either prefix is accepted interchangeably.

The access token must target Work IQ, not Graph or the Switch client. Entra v2
uses resource-qualified scopes to select the API. MCP's [authorization contract][mcp-auth]
also requires its resource indicator on authorization and token requests.
Switch `OAuthAdapter.endpoints()` [lines 237-336][oauth-endpoints] discovers the
MCP resource, but rejects Entra's missing S256 advertisement. Explicit endpoints
retain S256 in `authorization_url()`, yet set `resource=None`: both authorization
and token requests then omit it [lines 373-485][oauth-requests]. Explicit URLs
are therefore an experiment, not a complete compatibility fix. A successful
scope-selected token would not by itself settle MCP protocol compliance. Any
resource-preserving change requires review; do not weaken discovery checks.

Switch's [static settings][registry] require both client ID and secret. Start
with an operator-owned confidential Web app and an exact existing HTTPS Core
callback; do not infer support for a public client from Console's desktop UI.
The existing callback constructors are in [oauth_clients.py:38-71][callbacks].
Entra supports [S256 authorization code flow][code] and has [redirect matching
rules][redirects]; actual client type, callback and admin consent remain untested.

There is a second source-level incompatibility:

- `ServiceFlows.start()` selects write scopes when configured, otherwise read
  [lines 178-205][flow-start]. Catalog read/write lists are not a consent picker.
- `exchange_code()` uses the returned `scope` list **if present**, otherwise the
  requested list [oauth.py:481-485][oauth-requests]. `ServiceFlows.consent()`
  compares every configured scope literally [flows.py:351-363][consent].
- Entra documents `scope` as access-token permissions, with examples excluding
  requested `offline_access` and `openid`. Thus a returned business-only list can
  fail the current comparison when OIDC scopes are in the level. It is incorrect
  to conclude that every sign-in necessarily fails: an omitted `scope` takes the
  existing fallback. The Work IQ response has not been measured. [Code flow][code]

For review, separate requested protocol scopes from permissions proving the
access level. Require a refresh token for renewal and a validated ID token for
identity; continue rejecting missing business permissions. Test returned scopes,
absent scopes, reduced consent and accepted alias representations explicitly.
Do not globally strip prefixes or ignore arbitrary scopes. No such change is
implemented here.

### Smallest identity proposal for review

Today's [ConnectionIdentity][identity-schema] describes an authenticated JSON
GET. `OAuthAdapter.identify()` calls it with the newly issued access token
[lines 489-519][identify]. No compatible Work IQ profile GET was established
from the reviewed documentation. Graph `/me` and [Graph UserInfo][userinfo]
are not destinations for a Work IQ token. A Graph-only route could use
`User.Read` and `/me`; obtaining a second Graph token would add consent and
lifecycle work and is not the minimal Work IQ identity design.

If no supported native GET exists, propose a typed **ID-token identity mode in
Core**, alongside the existing mode, only after review:

1. Request `openid profile` and a fresh OIDC nonce bound to the one-time flow,
   client and intended resource tenant. The browser-cookie nonce in
   [flows.py:241-268][flow-nonce] is not an OIDC nonce sent to Entra.
2. Validate the ID token's signature with trusted Entra discovery/JWKS and an
   allowed algorithm; validate issuer, client audience, expiry/not-before and
   nonce before using claims. Do not trust token-supplied key URLs or unsigned
   claims, including a token returned on refresh. TLS is not the proposed
   substitute for signature validation. [ID tokens][id-tokens]
3. Bind validated `tid` to the intended, approved resource tenant, not merely to
   the token's own issuer string. `organizations` excludes consumer accounts but
   does not select or authorize a particular tenant. Treat guest membership as
   a separate tenant account. Derive the stable key from validated `tid:oid`;
   reject missing required identity claims rather than silently changing keys.
   Names/UPNs are labels, not identity. [Claims reference][claims],
   [tenant-binding guidance][validation]
4. Store the validated account identity, keeping the ID token out of agent
   tools. Use the Work IQ access token only for Work IQ; treat it as opaque,
   not as an identity JWT. [Access-token ownership][access-tokens]

The current adapter discards `id_token`; no OIDC validation/schema or tenant
field is added. The precise tenant-selection contract still needs agreement.
The static-client smoke check also needs honest presentation:
[app_checks.py:214-260][app-checks] interprets a dummy-code `invalid_grant` as
client acceptance. That heuristic cannot prove a real callback/consent flow;
this investigation did not repeat another contributor's invalid-client probe.

### Token lifecycle

The adapter requires positive integer `expires_in` and a refresh token, retains
a previous refresh token if no replacement arrives, and stores a replacement
when returned [oauth.py:403-435][oauth-requests]. Entra documents replacement
without invalidating the predecessor; that suggests Switch's `reusable`
semantics, subject to tenant verification. Refresh tokens can span resources
and tenants, so renewal must preserve the approved tenant/resource context.
[Refresh documentation][refresh]

Measure lifetime; do not copy a 5,400-second cap from a generic default.
Conditional Access/client policies can change it. The broker rejects tokens
outside the configured finite cap and serializes refresh under the connection's
database lock [broker.py:892-945 and 1151-1231][broker]. Missing refresh or
`invalid_grant` requires reconnect, not a broader permission request. No
app-scoped revocation endpoint was advertised; use the existing explicit
disconnect warning, with administrator consent-removal guidance. This does not
promise immediate invalidation of existing vendor tokens.

## D. Authorization and data safety

Entra consent bounds application capability; the user's permissions bound
resources; Work IQ policy makes additional request-time decisions. Policy is
initially tenant-wide, blocks mutations by default, and can change with up to
24-hour propagation. It is not a permanent per-Switch read-only boundary.
[Policy governance][policy]

| Condition | Required safe behavior / verification boundary |
| --- | --- |
| Tenant later permits writes; new tools appear | A read-only token must still refuse every mutation family, including actions/functions and `ask`-mediated writes. Otherwise defer; never infer read-only from tool names or a skill. |
| Cross-tenant/guest account switch | Reject tenant mismatch and require distinct account grants. Do not retain another tenant's authorization under a matching email. |
| Broad traversal or retrieved prompt injection | Bound paths, result sizes and calls; retrieved mail/chat/documents cannot authorize tool use, writes or exfiltration. Vendor collection limits do not replace an operation budget. |
| Policy denial or depleted billing | Surface the actual refusal; no automatic broader-scope consent, policy modification or retry loop. An uncertain mutation requires checking its result before retry. |
| Renewal refused | Core marks reauthorization required on `invalid_grant`; stop renewed access and reconnect. Existing issued-token expiry remains a separate limit. |
| Grant removed while Core is reachable | Existing 30-second grant polling should prevent subsequent session access within one minute; measure it with an already-running session, not a new session only. |
| Core unreachable after grant removal | **Existing availability exception:** cached credentials can still be returned until `useUntil`; this is not fail-closed within one minute. Do not claim otherwise. Maintainers must accept the existing boundary or approve a separate behavior change before promising stricter revocation. |
| Disconnect | Stop local broker use, drop session access through existing checks and report residual vendor validity; do not revoke all user sessions as an app-specific substitute. |

The outage exception is visible in
[AgentServiceTokens.answer/grantStands:58-125][host-tokens] and documented in
[service-connections-v2.md:112-136][token-policy]. No host policy is changed.
The [tool reference][tools] also caps collections and blobs, blocks pagination
parameters, and exposes nested per-path status/MCP errors: HTTP 200 alone is not
proof that a read or denial succeeded. Test actual results and `structuredContent`.
Credentials stay in Core/session-host handling, never in coding-tool arguments,
environment, files, room output or diagnostic captures.

## E. Licensing and costs

Microsoft's [2026-06-03 announcement][ga] dates Work IQ API GA to June 16 and
states there is no separate Work IQ subscription/SKU/per-user license. This is
not proof that every MCP tool is GA: `retrieve` remains public preview in the
[migration guide][migration]. Do not transfer Agent 365 or Enterprise MCP preview
rules to this endpoint.

For third-party agents such as Switch, [Work IQ pricing guidance][pricing]
requires usage-based Copilot Credits, including for Copilot-licensed users.
The [enablement guide][enable] requires a Copilot Studio usage-based plan linked
to an Azure subscription/resource group, an assigned user, and Global
Administrator one-time setup. Provisioning permissions belong to that admin's
setup session, not the Switch connector.

The [cost guidance updated 2026-11-05][costs] distinguishes credit capacity,
spending policies and payment methods: a spending limit does not reserve credits,
and a Copilot license does not replenish an exhausted Work IQ balance. No numeric
price, task-cost estimate or successful billing measurement is claimed here.
Before tenant testing, agree on allowed calls, a small spend limit and who pays;
measure direct entity calls separately from `ask`/`retrieve`. A free developer
sandbox is not evidence of Work IQ billing eligibility or workload entitlement.

## F. Decision / acceptance matrix

**All authenticated gates below are NOT TESTED.** Source-level incompatibilities
are identified separately; a proposed fix is not a PASS. Use synthetic data in
an administrator-approved tenant. References point to the preceding evidence.

| Gate | Microsoft contract | Current Switch / uncertainty | Minimum test and PASS condition (otherwise FAIL) | Safe action on FAIL |
| --- | --- | --- | --- | --- |
| Resource discovery / PKCE | Resource metadata and documented S256 (C). | Discovery rejects missing advertised S256; named URLs omit `resource`. | Capture sanitized authorization/token request structure: exact MCP resource, registered callback and S256; complete an exchange without weakening checks. PASS only after the resource-indicator contract is agreed and works. | Defer; request reviewed resource-preserving support or documented vendor guidance. |
| Correct audience | API-specific token; ID-token audience is the client (C). | Explicit URLs do not independently establish audience. | Request only the selected Work IQ API scope plus protocol scopes; obtain tenant diagnostic confirmation of the resource and a successful MCP read. Keep access tokens opaque in Switch and out of captures. PASS only for Work IQ-bound access, never a substituted Graph token. | Stop; correct registration/request, not a token-decoding identity workaround. |
| Requested/granted scopes | Read/Act/Ask definitions differ from advertised metadata (C). | Literal subset check; missing response `scope` falls back to request. | Focused adapter/flow cases: business-only returned scopes, omitted scope, reduced business consent and accepted aliases; real sanitized scope response. PASS only if valid protocol scopes do not cause rejection and missing business access still does. | Seek reviewed consent separation; never accept every scope or silently promote to Ask. |
| Durable read-only | Permission, user access and policy all apply (D). | Pass-through tools; no local classification; `read` is required by the current access schema. | Compare Read and separately consented write-capable controls under write-permitting policy, after propagation. Read must work; entity/action/function/agent-mediated mutations must fail without effects. | Keep disabled; request an honest access-model decision, not a write scope in the read field. |
| Stable identity | Validated issuer/client/tenant subject (C). | GET identity only; ID token discarded; browser nonce is not OIDC nonce. | Approved identity implementation: valid reconnect stable; reject bad signature/issuer/audience/time/nonce, missing identity and wrong resource tenant; home/guest accounts get distinct grants. | Reject sign-in; do not send Work IQ tokens to Graph or use email/unverified JWTs. |
| Token renewal | Refresh replacement and tenant/resource context (C). | Locked refresh and finite lifetime enforcement exist. | One real expiry/refresh with concurrent session requests; one revoked/expired refresh; privately confirm same tenant/resource. PASS: replacement stored once, permitted access continues, refusal requires reconnect, no expired token use. | Stop renewal, surface reconnect; no fabricated expiry or altered cap. |
| Tenant consent / client | Static app and admin-consented permissions (C). | Static secret settings, callbacks and an incomplete smoke-check heuristic exist. | Correct client/callback succeeds; absent consent, wrong client/secret/callback and denied user fail with no connected record. | Show setup/consent error; no copied first-party client, app-only/admin scopes or new redirect host. |
| Billing / entitlement | Assigned user and enabled spending/payment policy (E). | No Work IQ billing measurement. | Administrator confirms eligible plan and synthetic workloads; one bounded entity call and intended Copilot call appear under expected policy; denial/exhaustion stops further paid work. | Defer access; distinguish billing from OAuth failure and throttling. |
| MCP tools / data isolation | Runtime schemas, limits and per-path status (B/D). | Generic MCP proxy; Work IQ result shapes not exercised. | `initialize`, `tools/list`, then bounded mail/calendar/OneDrive/SharePoint/Teams reads, inaccessible data and oversized/limited response. PASS: actual results render, nested failures stay failures, no credentials leak. | Mark workload unsupported; block enablement if required coverage is absent. |
| Grant removal | Switch's issue requires access off within a minute. | Healthy-Core polling exists; outage permits bounded cached use (D). | Remove grant during an existing session; repeat requests past 60 seconds, then separately isolate Core. PASS: healthy-Core requests denied; outage behavior measured and explicitly accepted by maintainers or separately fixed. | No unconditional revocation claim; keep disabled if required outage guarantee is unmet. |
| Disconnect | Vendor and local revocation are distinct (C/D). | No advertised app revocation; existing warning path. | Disconnect with a cached session; next permitted recheck denies access, renewal cannot restart, residual vendor validity/warning is accurately reported. | Do not report global Microsoft revocation; provide administrator instructions. |

## G. Evidence and limitations

- **Documented and sourced:** Microsoft/MCP links below, retrieved 2026-11-07;
  publication/update dates are stated above where material.
- **Publicly probed without authentication:** the three GETs in C; response
  codes and selected public metadata only. These are not OAuth tests.
- **Inferred from source:** pinned Switch paths/lines; discovery, scope fallback,
  identity, refresh and cached-grant behavior. No application code was executed.
- **Requires an approved tenant:** every authenticated PASS in F, including
  read-only enforcement, guest identity, lifecycle, billing and room rendering.
- **Not tested:** sign-in, tool calls, token renewal/revocation, billing,
  unit suites, Docker and Console. No screenshots or demo recordings are claimed.

### Relationship to existing investigations

All five listed PRs were read with their diffs and review discussions. Their
main conclusions are already useful; this report does not claim a novel route.

| PR / reviewed head | Existing contribution and remaining distinction |
| --- | --- |
| [#1163](https://github.com/sandbox-quantum/switch/pull/1163), `62a7fcc8` | Clear report-only boundary and anonymous evidence. Its older one-permission snapshot should not replace today's three-permission reference. |
| [#1296](https://github.com/sandbox-quantum/switch/pull/1296), `0f5ab4c2` | Explicit permission/identity uncertainty and disabled-state coverage. Its 128-test result openly depends on an uncommitted CRLF workaround, so it does not establish pushed-commit Windows validation. |
| [#1430](https://github.com/sandbox-quantum/switch/pull/1430), `7247732e` | Disabled-draft/registry protection and reported full-suite validation (10,325 passes, one xfail). Draft safety does not resolve identity or MCP resource handling; Graph CLI retirement must inform the fallback. |
| [#1466](https://github.com/sandbox-quantum/switch/pull/1466), `5021b017` | Detailed Graph/CLI alternatives, validated identity and tenant test plan. The narrower scope-response cases and reachable-Core boundary above make its next checks more explicit. |
| [#1576](https://github.com/sandbox-quantum/switch/pull/1576), `f7884151` | Strong code tracing, scope/metadata observations, reported 141 loader passes and subsequent review corrections. Scope omission is conditional, not evidence every sign-in fails; the resource/tenant identity gates remain unresolved. |

Those test counts are contributor-reported evidence, not reruns. The review's
initial catalog-count objection on #1576 is not adopted: `microsoft-365` already
exists here. Its [resource-parameter concern][resource-review] corresponds to
the code, while the [identity discussion][identity-review] reinforces the need
for explicit validation. No competitor code, catalog draft or tests are copied.

The added decision value is the source-pinned PASS/FAIL matrix, the distinction
between missing and reduced scope responses, and the existing cached-access
exception under Core outage. None eliminates the need for tenant access.

[scope]: https://github.com/sandbox-quantum/switch/issues/822#issuecomment-6335481335
[overview]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview
[api]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview
[permissions]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions
[tools]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference
[policy]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp
[enable]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq
[pricing]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/
[costs]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/cost-considerations
[ga]: https://learn.microsoft.com/en-us/partner-center/announcements/2026-june#work-iq-api-and-consumptive-pricing-update
[migration]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/migrate-retrieval-api
[iq-cli]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/cli
[graph-cli]: https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-cli-retirement/
[ps]: https://learn.microsoft.com/en-us/powershell/microsoftgraph/authentication-commands
[enterprise]: https://learn.microsoft.com/en-us/graph/mcp-server/overview
[graph-perms]: https://learn.microsoft.com/en-us/graph/permissions-reference
[graph-auth]: https://learn.microsoft.com/en-us/graph/permissions-overview
[code]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
[redirects]: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
[userinfo]: https://learn.microsoft.com/en-us/entra/identity-platform/userinfo
[id-tokens]: https://learn.microsoft.com/en-us/entra/identity-platform/id-tokens
[claims]: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
[validation]: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
[access-tokens]: https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens
[refresh]: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
[mcp-auth]: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation
[shapes]: service-connections-v2.md#adding-a-connector
[token-policy]: service-connections-v2.md#tokens
[oauth-endpoints]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/adapters/oauth.py#L237
[oauth-requests]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/adapters/oauth.py#L373
[registry]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/registry.py#L47
[callbacks]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/oauth_clients.py#L38
[flow-start]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/flows.py#L178
[consent]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/flows.py#L351
[identity-schema]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/loader.py#L181
[identify]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/adapters/oauth.py#L489
[flow-nonce]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/flows.py#L241
[app-checks]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/app_checks.py#L214
[broker]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/core/switch_core/connections/broker.py#L892
[host-tokens]: https://github.com/sandbox-quantum/switch/blob/d51a31c1fcfaab94f6f7289f8099847d47343d72/console/packages/agent-providers/src/host/service-tokens.ts#L58
[resource-review]: https://github.com/sandbox-quantum/switch/pull/1576#discussion_r4488847701
[identity-review]: https://github.com/sandbox-quantum/switch/pull/1576#pullrequestreview-5795589032
