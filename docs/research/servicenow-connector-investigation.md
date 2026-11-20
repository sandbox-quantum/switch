# ServiceNow connector investigation

Status: research and feasibility analysis; no production ServiceNow instance connected.
Reviewed 2026-11-02.

## Recommendation

Do not enable a ServiceNow catalog entry in Switch yet. Unlike vendor-fixed remote MCP endpoints (such as Atlassian or Datadog), ServiceNow's official MCP server deployment model is strictly per-instance: each enterprise deploys an MCP server on its own tenant instance (`https://<instance>.service-now.com/sncapps/mcp-server/mcp/<server-name>`).

Switch's current connection catalog model assumes static, centrally defined MCP endpoint URLs and OAuth authorization base endpoints. Supporting per-tenant instances requires an architectural extension in Switch Core to safely store and validate user-supplied instance hosts without introducing Server-Side Request Forgery (SSRF) vulnerabilities or token leaks across instances.

Keep the ServiceNow catalog entry disabled as a placeholder (`enabled: false`). This document outlines the feasibility findings, security boundaries, OAuth requirements, and recommended architecture for maintainer agreement before enabling the connector.

---

## Architecture: Fixed vs. Instance-Aware Endpoints

| Capability | Vendor-Fixed MCP (Atlassian, Datadog) | ServiceNow Instance-Specific MCP |
|---|---|---|
| **Endpoint URL** | Static global URL (e.g. `https://mcp.atlassian.com/v1`) | Dynamic per-tenant URL (`https://<instance>.service-now.com/...`) |
| **Catalog Model** | URL hardcoded in `connection.yaml` (`mcp.url`) | Must be parameterized per connection instance |
| **OAuth Discovery** | Known global issuer (e.g. `auth.atlassian.com`) | Dynamic issuer (`https://<instance>.service-now.com/oauth_auth.do`) |
| **SSRF Risk** | Negligible (fixed outbound destination) | High if arbitrary hostnames or IP addresses are accepted |
| **Tenant Isolation** | Handled vendor-side via tenant selection grants | Tenant boundary is established at the DNS hostname |

### Feasibility Assessment
The integration is feasible, but requires a formal **Instance-Aware Connection Pattern** in Switch Core:
1. The connection creation UI must prompt the user for their ServiceNow instance name (`<subdomain>` or approved custom vanity domain).
2. Switch Core must validate the instance name against an allowlist pattern before issuing any network requests or initiating OAuth handshakes.
3. The catalog schema must support placeholder resolution (e.g. `mcp.url: "https://{instance}.service-now.com/sncapps/mcp-server/mcp/{server_name}"`) or an instance-aware adapter type.

---

## Security Boundaries & SSRF Mitigation

Allowing user-supplied instance hostnames is a primary attack vector for Server-Side Request Forgery (SSRF) targeting Switch infrastructure, local loopback interfaces, or cloud metadata services (e.g. `169.254.169.254`).

### Strict Host Validation Rules
Before any connection request is initiated:
1. **Subdomain Strict Matching:** The input must only allow alphanumeric characters and hyphens matching standard ServiceNow instance conventions: `^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$`.
2. **Domain Anchor:** The fully-qualified hostname must strictly end with `.service-now.com` (or enterprise `.service-now.us` for federal/regulated instances).
3. **No Raw IPs / Schemes / Ports:** Disallow user input containing scheme prefixes (`http://`, `file://`), IP addresses (`127.0.0.1`, `10.0.0.0/8`, `[::1]`), path traversals, ports, or userinfo credentials.
4. **Custom Enterprise Domains:** If custom enterprise vanity domains are allowed in the future, they must be validated through DNS CNAME resolution and maintainer/tenant admin pre-configuration, never unverified end-user input.
5. **DNS Rebinding Protection:** The connection runner and gateway must pin resolved IP addresses and refuse loopback/link-local/private RFC 1918 ranges at transport level.

---

## Authentication & OAuth 2.0 Lifecycle

ServiceNow supports OAuth 2.0 for external clients with PKCE.

### Grant & Protocol
- **Grant Type:** Authorization Code Grant (`response_type=code`).
- **PKCE:** Proof Key for Code Exchange with `code_challenge_method=S256` must be enforced to prevent authorization code interception.
- **Endpoints:**
  - Authorization: `https://<instance>.service-now.com/oauth_auth.do`
  - Token: `https://<instance>.service-now.com/oauth_token.do`
  - UserInfo / Identity: `https://<instance>.service-now.com/oauth_userinfo.do` or table API `/api/now/v1/table/sys_user?sysparm_query=user_name=...`
- **Scopes:** Scopes should be scoped to the minimum required role-based permissions or OAuth entity scopes defined in the ServiceNow OAuth Application Registry.

### Token Lifecycle & Revocation
- **Refresh Flow:** ServiceNow issues refresh tokens when configured in the Application Registry profile (`Refresh Token Lifespan`). Refresh requests must use `grant_type=refresh_token`.
- **Revocation:** External clients can revoke tokens via ServiceNow's revocation endpoint or token invalidation tables. Revoking a connection in Switch Console must discard stored session credentials immediately.
- **Credential Storage:** All tokens and refresh tokens must reside exclusively within the Switch session host keyring; no credentials may leak into agent prompts, transcripts, or rooms.

---

## ServiceNow Instance Prerequisites

To expose the MCP server and authorize Switch agents:
1. **Plugin Requirement:** The instance must have the ServiceNow MCP Server Platform Manager (`com.glide.mcp`) or Intelligent Experiences MCP plugin installed and enabled (Zurich / Washington DC releases or newer).
2. **Application Registry:** A System Administrator (`admin` role) must create an OAuth API endpoint in **System OAuth > Application Registry** ("Create an OAuth API endpoint for external clients").
3. **MCP Server Configuration:** The administrator must configure an MCP Server in the ServiceNow MCP Platform Manager, explicitly choosing which tools and capabilities are exposed to external clients.
4. **Least-Privilege Roles:** The connecting user should be granted targeted roles (e.g. `snc_read_only`, `itil` read access) rather than `admin`. All requests executed via the MCP server inherit the Access Control Lists (ACLs) of the authenticated user.

---

## Workflow Scope & Agent Boundaries

### Read-Only vs. Mutating Operations
- **Supported Read Workflows:**
  - Querying and viewing incident records (`incident` table).
  - Retrieving knowledge base articles (`kb_knowledge` table).
  - Summarizing service change requests and catalog task statuses.
- **Mutating Operations (Write / Update / Close):**
  - Updating incident urgency, assigning tickets, or triggering catalog workflows must require explicit human-in-the-loop approval in Switch rooms (`requestApproval`).
  - Pass-through execution of mutating tools without human review must be forbidden in default and `approval-required` modes.

---

## Roadmap & Next Steps

1. **Maintainer Alignment:** Agree on the architectural approach for instance-aware connections in Switch Core.
2. **Schema Support:** Update `SwitchConnectionDefinition` and loader to support parameterized instance URLs or an instance-aware connection type.
3. **Host Validation Harness:** Implement and test strict host validation and SSRF defenses in `core/switch_core/connections/`.
4. **Developer Instance Validation:** Register an OAuth client on a ServiceNow Developer Program PDI (Personal Developer Instance), verify PKCE S256 handshake, token refresh, and user identification.
5. **Tool & Skill Documentation:** Once the backend supports the connection shape, populate `core/switch_core/connections/catalog/servicenow/` with full adapter definitions and author `skill/SKILL.md`.

---

## References

- [ServiceNow MCP Server Console Documentation](https://www.servicenow.com/docs/r/zurich/intelligent-experiences/mcp-platform-manager-landing.html)
- [Creating a ServiceNow MCP Server](https://www.servicenow.com/docs/r/intelligent-experiences/create-mcp-server.html)
- [Connecting to a ServiceNow MCP Server](https://www.servicenow.com/docs/r/intelligent-experiences/enable-ai-experiences/connect-mcp-server-client.html)
- [ServiceNow OAuth 2.0 Setup](https://www.servicenow.com/docs/bundle/vancouver-platform-security/page/administer/security/concept/c_OAuthApplications.html)
- [Switch Service Connections v2 Architecture](https://github.com/sandbox-quantum/switch/blob/main/docs/design/service-connections-v2.md)
