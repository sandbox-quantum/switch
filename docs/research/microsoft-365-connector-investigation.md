# Microsoft 365 connector investigation

Status: research only; no Work IQ tenant was available for authenticated testing.
Reviewed 2026-11-02.

## Recommendation

Do not enable a Microsoft 365 catalog entry yet. Work IQ's remote MCP is the
closest fit to the requested integration, but its advertised OAuth scope does
not establish a read-only grant, and the OAuth adapter cannot currently use an
OIDC ID token to identify the connected account. The permission discrepancy
and identity flow need maintainer review and tenant validation before the
connector can safely be enabled.

Keep the existing Microsoft 365 placeholder disabled. Do not add an identity
mode or tenant configuration field as part of this investigation.

## Work IQ and Microsoft Graph

| | Work IQ remote MCP | Microsoft Graph |
|---|---|---|
| Interface | One MCP endpoint with generic tools over resource paths, schema discovery, and Copilot grounding. | REST APIs and SDKs for Microsoft 365 workloads, including Outlook, calendar, OneDrive, SharePoint, and Teams. |
| Authorization | Entra delegated OAuth for Work IQ. Work IQ applies tenant policy and the signed-in user's Microsoft 365 permissions. | Entra delegated scopes are selected per API/resource. Effective access is bounded by both the app's consented scopes and the signed-in user's permissions. App-only access is a separate, broader model and is not recommended here. |
| Connector fit | Directly matches the remote-MCP catalog shape and avoids packaging a client executable. | The issue proposes a CLI, but no particular CLI, supported release, checksum, or safe command allowlist was validated in this investigation. A CLI implementation would need all of these before it could satisfy Switch's connector rules. |
| Main concern | Broad tool surface and a mismatch between current endpoint metadata and the documented read permission; see below. | More direct scope selection, but workload permissions and consent requirements must be designed and tested. Teams and SharePoint access may require administrator consent or broader permissions depending on the endpoint and permission chosen. |

**Assessment:** Prefer Work IQ only if a tenant test proves that the MCP endpoint
accepts a read-only permission and the sign-in identity can be validated without
reusing a token for the wrong audience. Otherwise, evaluate a specific Graph
client/CLI against the connector's no-shell, pinned-release, and command-denial
requirements. Microsoft Graph itself is an API, not a pre-validated Switch
connector shape.

## Licensing and tenant setup

Microsoft's Work IQ API overview says API usage is billed through
usage-based Copilot Credits. The tenant enablement guide lists a Copilot Studio
usage-based billing plan linked to an Azure subscription and resource group,
assignment of the test user to that plan, and a Global Administrator for the
one-time setup. It also describes provisioning the Work IQ service principal.
The documented Graph Explorer permission used for that one-time provisioning
is limited to that administrator's Graph Explorer session; it is not a
permission the Switch connector should request.

The reviewed documentation does not provide a cost estimate for this
connector's expected use. Actual billing depends on usage and the tenant's
configured Copilot Credits billing and spending controls. Do not describe the
connector as free or assume an ordinary Microsoft 365 subscription enables
Work IQ API usage.

The issue describes Work IQ MCP as preview. The current MCP overview identifies
the `retrieve` tool as public preview but does not establish the release status
of every MCP capability. Availability and eligibility for a particular tenant
remain unverified.

## Permissions and write policy

The current [Work IQ permissions reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)
documents delegated permissions including:

- `WorkIQ.Read`, described as read access to Microsoft 365 data available to
  Work IQ agents.
- `WorkIQ.Act`, described as reading and making changes to Microsoft 365 data.
- `WorkIQAgent.Ask`, described as asking Work IQ agents and including read and
  write access.

The permissions page says an organization administrator must enable Work IQ
before these permissions can be used, and marks them as requiring admin
consent. However, the live protected-resource metadata at
`https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp`
advertised only
`fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask` when checked on
2026-11-02. The permissions reference documents the scope in
`api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask` form. No tenant was
available to test whether the MCP server accepts `WorkIQ.Read`. The MCP
overview also refers to four broad OAuth permissions, while the permissions
reference currently lists three delegated permissions. These differences
must be resolved against the actual MCP sign-in and returned token scopes;
do not infer that a read-only access level works from the documentation alone.

The [MCP policy guide](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp)
says mutations (including create, update, delete, and actions such as sending
email) are blocked by default. Administrators can enable supported mutations
through tenant policy. The initial policy controls are tenant-wide, not
per-app, per-agent, or per-user, and a policy change can take up to 24 hours to
apply. The policy does not replace the user's Microsoft 365 permissions.

This default is useful tenant governance, but it does not give Switch a
per-agent read-only enforcement boundary. With pass-through MCP tools, a skill
instruction not to mutate is guidance, not authorization. Do not advertise a
Switch `read` grant as enforceably read-only while relying only on tenant
policy.

## Identity

Work IQ MCP access tokens are issued for the Work IQ resource. Microsoft's
[UserInfo documentation](https://learn.microsoft.com/en-us/entra/identity-platform/userinfo)
describes UserInfo as a Microsoft Graph endpoint and says to call it with a
Graph access token; it recommends using an ID token for identity when one is
available. A Work IQ access token must not be sent to Graph UserInfo or Graph
`/me` as an identity lookup unless Microsoft documents and testing proves that
the token is valid for Graph.

The suitable identity mechanism to investigate is the OIDC ID token returned
by Entra during the authorization-code flow: validate its signature using
Entra's discovery document and JWKS, and validate issuer, audience, expiry,
and a nonce bound to the authorization request. For a work account, prefer
validated tenant and object identifiers (`tid` and `oid`) when present;
otherwise use the validated, client-bound OIDC subject (`sub`). Treat email
only as a display label, not as the stable account key.

Switch's current catalog identity contract performs an authenticated GET and
extracts JSON fields. Its OAuth adapter stores access token, refresh token,
expiry, and scope from the token response; it does not retain or validate an
ID token and does not currently bind a nonce to the authorization flow.
Therefore ID-token identity requires an explicit, typed adapter change and
security tests. This report does not implement that change.

## Validation boundary and next checks

This report is based on public Microsoft documentation, live OAuth discovery
metadata, and source inspection. There was no Work IQ tenant, Entra app, or
test data available. The following remain unverified:

- Whether the MCP endpoint accepts `WorkIQ.Read` and which scope appears in
  the token response.
- The exact OAuth client registration, callback, PKCE exchange, and ID-token
  claims for a Switch client.
- Work IQ access-token lifetime, refresh behavior, and vendor-side revocation.
- Which requested Outlook, calendar, OneDrive, SharePoint, and Teams paths are
  enabled for a test user, and the policy response for a denied mutation.
- The distribution, checksums, and safe command surface of any proposed Graph
  CLI.

Once maintainers choose the intended auth and read-only boundary, validate
those items with an administrator-approved developer tenant and synthetic
data before enabling the catalog entry. Do not put tenant URLs, account
identifiers, tokens, or real Microsoft 365 data in the repository.

## Sources

- [Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview)
- [Work IQ API overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/api-overview)
- [Work IQ API permissions reference](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)
- [Enable your tenant for Work IQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)
- [Policy governance for Work IQ MCP](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/policy-governance-mcp)
- [Usage-based billing and Copilot Credits](https://learn.microsoft.com/en-us/microsoft-365/copilot/usage-based-billing-overview-copilot-credits)
- [Microsoft Graph overview](https://learn.microsoft.com/en-us/graph/overview)
- [Microsoft Graph permissions overview](https://learn.microsoft.com/en-us/graph/permissions-overview)
- [Microsoft Entra OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
- [Microsoft identity platform UserInfo endpoint](https://learn.microsoft.com/en-us/entra/identity-platform/userinfo)
