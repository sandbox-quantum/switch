# Microsoft 365 connector investigation: Work IQ and Microsoft Graph

**Issue:** [#822](https://github.com/sandbox-quantum/switch/issues/822)  
**Research snapshot:** 2026-10-29  
**Status:** Investigation report only. No authenticated tenant test or connector implementation is claimed.

## Executive recommendation

Work IQ Remote MCP is the best architectural fit for the requested agent-facing Microsoft 365 experience: it exposes mail, calendar, files, Teams messages and other workloads through one MCP endpoint, and Microsoft recommends MCP when an AI assistant should invoke Work IQ as a tool for a user. However, this is **not yet ready to enable in Switch**.

Three compatibility gates remain:

1. **Identity:** Switch's OAuth connection loader requires a stable account identifier returned by an authenticated JSON `GET`. Microsoft documents Entra delegated authentication for Work IQ MCP, but the reviewed Work IQ documentation does not document a user-info endpoint that accepts a Work IQ access token. The live unauthenticated challenge and protected-resource metadata establish OAuth resource discovery, not a stable user identity.
2. **Authorization:** The current Work IQ permission reference documents `WorkIQAgent.Ask` as delegated and explicitly describes it as including both read and write access. It requires admin consent. Work IQ MCP separately blocks mutations by default through tenant policy, but that policy is tenant-wide in the initial release, can take up to 24 hours to apply, and is not a per-Switch-app or per-agent read/write grant. Therefore Switch must not label the connection read-only based only on a tenant's current policy setting.
3. **Tenant and cost prerequisites:** Enabling Work IQ requires a tenant administrator, a Copilot Studio usage-based billing plan backed by an Azure subscription and resource group, and the test user assigned to the plan. Work IQ API usage is metered with Copilot Credits. Exact cost per workload and expected cost for Switch usage must be established with an administrator and the current billing estimator; this report does not invent a price.

Recommendation: keep the catalog placeholder disabled and deliver this report as the current issue outcome. Ask maintainers to confirm whether they want a narrowly scoped generic OAuth identity enhancement if Work IQ has no supported identity `GET`. Only then proceed to a disabled draft or enabled connector, and only after an administrator-approved tenant test confirms actual OAuth, tool, policy and billing behavior.

## What Work IQ provides

Microsoft describes Work IQ as a workplace-intelligence layer over Microsoft 365 data. The remote MCP server presents a small generic tool surface for entity reads and mutations, Copilot-backed `ask`/`retrieve`, and runtime schema discovery. Tools operate on relative resource paths such as `/me/messages` or `/me/chats/{id}/messages`; schemas are discovered at runtime rather than represented as a fixed list of per-workload tools. The documented workload areas include email, calendar, OneDrive and SharePoint files, Teams messages, people, Planner and enterprise search.

The issue's endpoint is `https://workiq.svc.cloud.microsoft/mcp`. An unauthenticated request made for this report returned `401` with a `WWW-Authenticate` challenge naming path-specific protected-resource metadata. A separate unauthenticated request to `https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp` returned:

- resource: `https://workiq.svc.cloud.microsoft/mcp`;
- authorization server: `https://login.microsoftonline.com/organizations/v2.0`;
- advertised scope: `fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask`.

These are anonymous discovery observations, not proof of a successful authorization-code exchange, the exact scope string Switch must request, or a usable authenticated identity endpoint. The challenge included a transient service challenge value; it is deliberately not recorded here.

The current Microsoft Learn permission reference instead documents the scope as `api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask`, identifier `0b1715fd-f4bf-4c63-b16d-5be31f9847c2`, delegated only, and admin-consent-required. The live metadata and permission page therefore need to be reconciled during tenant testing: verify the exact consent request and the `scope`/audience representation returned in tokens rather than copying either representation into a catalog entry without a successful flow.

There is a second documentation discrepancy to resolve: the MCP overview describes four broad OAuth permissions, while the reviewed permissions reference currently lists only `WorkIQAgent.Ask`, and live resource metadata advertised one scope. Do not infer additional permissions or split access levels from the overview text. Confirm the permission surface in the target tenant and with current Microsoft documentation before enabling anything.

## Work IQ compared with Microsoft Graph

| Concern | Work IQ Remote MCP | Microsoft Graph directly |
|---|---|---|
| Switch fit | Native remote MCP endpoint, which matches the service-connection catalog shape. | REST API/SDK, not an MCP endpoint. The current v2 connector shapes do not provide a generic first-party Graph REST adapter. A CLI route would need an official, supportable CLI and the repository's pinned-binary/no-shell restrictions; a custom REST broker is outside this report and would need maintainer agreement. |
| User context | Delegated Entra authentication; requests act in the signed-in user's context. App-only authentication is not supported for Work IQ. | Supports delegated and application permissions. A user-scoped connector should use delegated permissions and avoid application permissions. |
| Permission granularity | One documented delegated permission covers Work IQ agent questions and includes read/write access. Work IQ policy can then filter paths and operations. | Granular resource and operation scopes (for example, resource-specific `Read` and `ReadWrite` permissions) make it possible to request only the workload operations needed. Each workload still needs careful permission selection and consent review. |
| Governance | Work IQ MCP adds a request-time policy layer over Entra consent and the signed-in user's Microsoft 365 permissions. Initial policy controls are tenant-scoped; mutations default to blocked, and policy changes may take up to 24 hours to apply. | Microsoft Graph enforces the granted OAuth permissions and the user's permissions. Application permissions can be tenant-wide and are substantially broader; use delegated scopes if Graph is selected. |
| Agent experience | Generic MCP tools, runtime path/schema discovery, Copilot reasoning/retrieval, and source-grounded responses. | Direct resource API calls; the integration must expose a safe tool surface and explain pagination, throttling and individual endpoint behavior. Graph itself does not provide Work IQ's MCP tool contract. |
| Cost | Work IQ API consumption uses Copilot Credits; access and billing setup are tenant-dependent. | Microsoft Graph is accessed under Microsoft 365 licensing and API permission terms; individual APIs may have their own service-specific limits or metering. It does not automatically provide Work IQ Copilot grounding. |
| Main risk for this issue | Broad delegated scope, tenant-wide write policy, documented identity gap, tenant/billing prerequisites and product evolution. | Large number of scopes and endpoints, no existing generic REST connector shape, potential temptation to use a broad unofficial CLI or app-only auth. |

**Assessment:** Work IQ is preferable if the requirement is a user-facing MCP assistant with cross-workload context and the tenant accepts its broad delegated permission and usage model. Graph is preferable only if the product deliberately narrows the required workloads and needs resource-specific delegated scopes. Graph is not a drop-in substitute for Work IQ's MCP interface. Microsoft also documents Work IQ as the recommended foundation for new agentic applications on Microsoft 365 data; that recommendation does not remove Switch's identity, consent, cost or policy gates.

## Authentication, identity and Switch compatibility

The Work IQ docs describe Entra delegated authentication and the endpoint metadata advertises the `organizations` v2 authority. The issue says there is no dynamic client registration and requires a statically registered Entra application with tenant admin consent. This implies a static OAuth client if implementation proceeds; the exact client ID/secret provisioning and redirect URI must follow Switch's existing operator-configured static-client mechanism. No Microsoft-owned client ID should be copied or reused.

The main Switch mismatch is identity, not the MCP transport. `core/switch_core/connections/loader.py` models `ConnectionIdentity` as an HTTPS URL and JSON paths for account ID and human-readable label; the loader's documented contract is an authenticated `GET` using the access token. The current Microsoft documentation reviewed for this report does not identify a Work IQ user-info route. The Work IQ metadata's `sub`, `tid`, or other claims (if present in a token) must not be treated as identity unless the token is cryptographically validated for the expected issuer, audience, expiry and flow. The current catalog schema does not consume an OIDC ID token as an identity source.

Before implementation, test with an approved tenant:

1. Register a Switch-owned static Entra application with the exact existing Switch callback and authorization-code PKCE S256.
2. Confirm the exact authority, consent URL, audience and scope needed for the Work IQ MCP resource. Do not send a Work IQ token to Microsoft Graph `/me` or Graph UserInfo; tokens are audience-bound.
3. Test whether Work IQ documents or accepts an authenticated JSON identity `GET` using that Work IQ token. Record only the endpoint contract and synthetic account identifiers, never actual tenant data.
4. If no supported identity `GET` exists, stop and ask maintainers to approve a typed OIDC ID-token identity mode in the shared OAuth adapter. Such a change would need signature/JWKS validation, issuer, audience, expiry and nonce validation, plus tenant-safe stable subject mapping. Decoding an unverified access token is not an acceptable workaround.
5. Verify refresh-token issuance, rotation semantics, token lifetime and revocation/disconnect behavior through the actual flow. Do not mark `refresh` as rotating or reusable based on Entra's generic behavior alone.

The existing catalog entry at `core/switch_core/connections/catalog/microsoft-365/connection.yaml` is only a disabled placeholder. Keeping it disabled is correct until the identity and tenant validation gates are answered.

## Authorization and safe access levels

Microsoft's current permission page describes `WorkIQAgent.Ask` as a delegated permission that includes read and write access to Microsoft 365 resources accessible to Work IQ agents and scoped to the signed-in user. Microsoft separately documents that Work IQ MCP tenant policy blocks mutation operations by default, including create, update, delete and modifying actions such as sending mail. Administrators may enable supported mutation scenarios through the Microsoft 365 admin center.

This gives two layers of controls, neither of which should be misrepresented:

- Entra consent is broad and requires admin consent for the documented permission.
- Work IQ policy evaluates each request, but the initial policy surface is tenant-wide, not per app, user, or agent. A policy change can take up to 24 hours to apply.
- The connected user's Microsoft 365 resource permissions remain in force; policy cannot grant access the user does not have.
- Generic tools include `create_entity`, `update_entity`, `delete_entity`, and `do_action`. Hiding a tool in an agent prompt or catalog does not prove the service rejects a direct call.

Therefore, Switch must not advertise a read-only access level merely because the default tenant policy currently denies mutations. A read-only label is valid only if a supported control can enforce it for the connection/session and tests prove attempted mutations are rejected. If no per-connection enforcement is available, the honest options are a single write-capable access level with explicit disclosure, or deferring the connector until a safe mode is agreed. Never let the connector change tenant policy.

The skill should treat email, chat messages, files and retrieved content as untrusted data; begin with bounded reads and schema discovery; avoid traversing whole mailboxes/sites; and require explicit confirmation before any write, send, delete or other consequential action. Policy denials should be surfaced as policy decisions, not retried as transient failures.

## Licensing, billing and tenant setup

The current Work IQ API overview states that API use is metered through Copilot Credits and usage-based billing. It says this billing model is independent of a Microsoft 365 Copilot license: a Copilot-licensed user may still incur usage-based charges for custom/third-party agents, and unlicensed users are billed based on usage. Do not tell users that a normal Microsoft 365 subscription makes the connector free, and do not claim a Copilot license is universally required for Work IQ API access.

The tenant enablement page lists these prerequisites:

- a usage-based billing plan configured in Copilot Studio, backed by an Azure subscription and resource group;
- the user assigned to that billing plan;
- a Global Administrator for one-time Work IQ tenant setup.

The Work IQ MCP overview notes that a Work IQ service principal may be provisioned automatically on first use; its tenant enablement guide documents explicit provisioning steps for cases where setup or policy configuration needs it. The operator documentation should explain the prerequisite and avoid requiring a user to perform broad Graph administration as part of ordinary connection setup.

The price depends on usage, billing method and tenant spending policy. Admins can configure spending limits, access policy and alerts through Microsoft 365 Copilot Cost Management. The report does not estimate per-call or per-user cost because the reviewed public documentation does not provide a fixed Switch-specific rate. Before enabling, an administrator should confirm a budget, meter the real test flows, and decide whether `ask`/`retrieve` features are in scope. Microsoft marks `retrieve` as public preview in the MCP overview.

## Implementation decision and proposed next steps

### Gate 0: maintainers agree on the outcome

This report fulfills the investigation-first instruction on #822. Confirm that a report-only PR is useful and ask whether maintainers want the connector kept disabled pending tenant access. No catalog implementation should imply successful sign-in or production readiness.

### Gate 1: supported identity and OAuth contract

With an administrator-approved tenant, establish the exact OAuth request, redirect registration, resource scope, identity source, token refresh behavior and disconnect semantics. If identity needs shared adapter changes, agree on a typed design before touching generic OAuth behavior.

### Gate 2: permissions and user-visible claims

Confirm the current scope list and its delegated consent requirements; reconcile the live metadata with the permission reference; test each workload and representative denied path. Choose a truthful access label based on server-enforced write restrictions, not skill instructions. Document tenant-wide policy and propagation delay.

### Gate 3: billing and capability scope

Establish the required billing configuration and test-user entitlement. Set a bounded budget and decide whether Copilot `ask`/preview `retrieve` is included. Validate the listed mail, calendar, file, SharePoint and Teams paths against synthetic data and the live tool schemas. Keep unsupported resources out of the skill.

### Gate 4: Switch connector and acceptance evidence

Only after the prior gates pass, replace the placeholder with the static OAuth/MCP entry and a credential-free skill. Add loader assertions and focused adapter tests for any approved shared change. Validate refresh, grant removal within one minute, disconnect, secret redaction and room use. Run the repository's required `just check`, `just typecheck` and `just test`; report automated tests separately from authenticated tenant QA. Provide the issue's requested connect → grant → use → grant-off demonstration only after reviewing it for secrets and personal data.

## Evidence and unresolved questions

| Topic | Status as of this report |
|---|---|
| Remote MCP endpoint and path-specific protected-resource metadata | Independently checked anonymously on 2026-10-29. This does not prove OAuth completion. |
| Authorization server and advertised scope | Anonymous metadata observed; exact OAuth scope/consent contract still needs a successful test. |
| Admin consent | Documented as required for `WorkIQAgent.Ask`. |
| Work IQ API billing | Documented as Copilot Credits usage-based; no Switch-specific cost measured. |
| Tenant provisioning | Documented billing-plan, assigned-user and Global Administrator prerequisites. |
| Mutation policy | Documented default-deny behavior, tenant-wide initial control and up-to-24-hour propagation. Not tested in a tenant. |
| Stable identity endpoint | Not found in reviewed public Work IQ documentation; no authenticated tenant test available. |
| Refresh, revocation, token lifetime | Not measured. |
| Per-connection read-only enforcement | Not established. Do not advertise a read-only mode. |
| Mail/calendar/files/SharePoint/Teams calls | Supported workloads are described in documentation; no authenticated calls were made. |
| Work IQ MCP `tools/list` and Switch response handling | Not tested. Verify live schemas and `structuredContent` behavior before writing examples. |

## Sources

All vendor sources below are Microsoft primary documentation, reviewed on 2026-10-29:

1. [Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview) — MCP tool categories, authentication discovery, preview note for `retrieve`.
2. [Work IQ API permissions reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions) — `WorkIQAgent.Ask`, scope alias, delegated permission, admin consent, read/write description.
3. [Enable your tenant for Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq) — billing-plan, assigned-user and administrator prerequisites.
4. [Policy governance for Work IQ MCP](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp) — tenant-level policy, default mutation blocking, 24-hour propagation, layered access control.
5. [Work IQ MCP tool reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference) — entity tools, relative paths, response limits, `structuredContent`, path controls and error behavior.
6. [Work IQ API overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview) — workload coverage, protocol choice, delegated authentication, multitenant issuer requirement and Copilot Credits billing.
7. [Usage-based billing and cost management for Copilot Credits](https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-overview-copilot-credits) — eligible services, policy controls and billing methods.
8. [Microsoft Graph overview](https://learn.microsoft.com/en-us/graph/overview) — Graph API surface and access model.
9. [Overview of Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-overview) — delegated vs application permissions and least-privilege guidance.

Repository references checked in the updated checkout: `docs/design/service-connections-v2.md`, `core/switch_core/connections/loader.py`, `core/switch_core/connections/adapters/oauth.py`, and the disabled placeholder at `core/switch_core/connections/catalog/microsoft-365/connection.yaml`.
