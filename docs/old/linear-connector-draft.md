# Linear connector configuration draft

Linear remains disabled while identity is unresolved. This configuration has no identity and cannot be enabled without a supported identity route. Measurements and the maintainer decision are recorded in the catalog entry. The skill is retained separately as a draft.

```yaml
adapter: oauth
auth:
  type: oauth
  refresh: rotating
  oauth:
    registration: dynamic
    redirect: [loopback, core]
    revocation_discovered: true
  # Identity is intentionally unset until a supported, guarded route exists.
token: { kind: pass_through, max_lifetime: 86400 }
mcp:
  servers:
    - { name: linear, url: "https://mcp.linear.app/mcp" }
access:
  read:
    scopes: [read]
  write:
    scopes: [read, write]
tools: { mode: pass_through }
```
