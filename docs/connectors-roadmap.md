# Switch connectors: roadmap

Service connectors contributors can add, what's known about each, and the rules
every connector follows. As of 9 Oct 2026.

## Before filing contributor issues

1. **Merge the PR stack first.** The connector work is in draft PRs
   [#690](https://github.com/sandbox-quantum/switch/pull/690) →
   [#732](https://github.com/sandbox-quantum/switch/pull/732) →
   [#736](https://github.com/sandbox-quantum/switch/pull/736). A fork of `main`
   today has none of the files the issues point to. Until the stack merges,
   contributors start from `feat/connectors-v2-phase2`.
2. **Create the labels.** `connector` and `needs-design` don't exist yet.
3. **Hold anything that needs a broker change**, such as API keys or cloud IAM.
   Those need a design before they get contributor issues.

## How a connector works

Every connector answers two separate questions.

- **Sign-in: how does Switch get a token for the person's account?** Usually
  OAuth: the person clicks Connect, signs in on the vendor's own page and
  approves the access, and the vendor hands Switch a token. Some vendors only
  offer an API key (a long-lived secret the person pastes in) or cloud IAM. The
  broker doesn't support those yet.
- **Tools via: how does the agent use the service with that token?** Through
  the vendor's hosted MCP server, so the agent sees the vendor's own tools;
  through the vendor's official CLI, which the session host runs with the token
  in its environment; or through Switch's own adapter code.

Either way the session host holds the token and makes the calls. In an
`oauth` catalog entry, `auth` answers the first question, and an `mcp` or a
`cli` block (never both) answers the second.

## Integration patterns

The first connectors used these patterns. They are examples, not a fixed list.
A vendor may fit one, mix two, or need something new. When it doesn't fit, say
what the vendor offers in the issue and we'll work out the approach together.

| Sign-in            | Tools via   | Example                 | What a PR adds                                           |
| ------------------ | ----------- | ----------------------- | -------------------------------------------------------- |
| OAuth              | Vendor MCP  | Atlassian (#732)        | `connection.yaml`, skill, logo, tests                    |
| OAuth              | Vendor CLI  | Google Workspace (#736) | The same, plus a pinned CLI release and allowed commands |
| OAuth (GitHub App) | Own adapter | GitHub (#690)           | Broker code. Talk to maintainers first                   |
| API key, cloud IAM |             | No fit yet              | A broker change. Open an issue to discuss first          |

## Connectors

- **Catalog entry** is the entry under
  [`catalog/`](../core/switch_core/connections/catalog) to start from, if one
  exists. Each entry is one connection a person signs in to, and its slug (the
  folder name) is unique. Rows that share an entry would extend it rather than
  add a new one: Jira and Confluence both sit on `atlassian`.
- **Sign-in** and **Tools via** say only what the repo already records: the
  auth type in a placeholder, or how a built connector works. Blank means
  nobody has decided yet.
- **Hosted MCP** (does the vendor run one?) and **Free tier** are blank until
  someone checks. Fill them in with your PR or issue, and link the vendor's
  docs there.

| Category                  | Connector         | Catalog entry      | Sign-in   | Tools via   | Hosted MCP | Free tier | Notes                                                    |
| ------------------------- | ----------------- | ------------------ | --------- | ----------- | ---------- | --------- | -------------------------------------------------------- |
| Enterprise Knowledge      | Glean             |                    |           |             |            |           |                                                          |
| Developer Tools           | GitHub            | `github`           | OAuth     | Own adapter |            |           | In review in #690                                        |
|                           | GitHub Enterprise | (new)              |           |             |            |           | Needs its own entry; see below the table                 |
|                           | GitLab            | `gitlab`           | OAuth     |             |            |           |                                                          |
|                           | Bitbucket         | `bitbucket`        | OAuth     |             |            |           |                                                          |
|                           | Azure DevOps      |                    |           |             |            |           |                                                          |
|                           | Supabase          |                    |           |             |            |           |                                                          |
| Project Management        | Jira              | `atlassian`        | OAuth     | Vendor MCP  | Yes        |           | In review in #732                                        |
|                           | Linear            | `linear`           | OAuth     |             |            |           |                                                          |
|                           | Asana             | `asana`            | OAuth     |             |            |           |                                                          |
|                           | Monday.com        |                    |           |             |            |           |                                                          |
|                           | ClickUp           |                    |           |             |            |           |                                                          |
|                           | Trello            |                    |           |             |            |           |                                                          |
| Docs & Wikis              | Confluence        | `atlassian`        |           |             |            |           | Likely extends the Atlassian entry (to check)            |
|                           | Google Workspace  | `google-workspace` | OAuth     | Vendor CLI  |            |           | Drive, Docs, Sheets, Slides, Calendar. In review in #736 |
|                           | Microsoft 365     | `microsoft-365`    | OAuth     |             |            |           | OneDrive, Outlook, Word, Excel. SharePoint to check      |
|                           | Notion            | `notion`           | OAuth     |             |            |           |                                                          |
|                           | Airtable          |                    |           |             |            |           |                                                          |
|                           | Box               | `box`              | OAuth     |             |            |           |                                                          |
|                           | Dropbox           |                    |           |             |            |           |                                                          |
| Meeting Intelligence      | Granola           |                    |           |             |            |           |                                                          |
| Customer Intelligence     | Gong              |                    |           |             |            |           |                                                          |
| Observability & Incidents | Datadog           | `datadog`          | API key   |             |            |           | Check for a vendor OAuth MCP server                      |
|                           | PagerDuty         |                    |           |             |            |           |                                                          |
|                           | Sentry            |                    |           |             |            |           |                                                          |
|                           | New Relic         | `new-relic`        | API key   |             |            |           | Check for a vendor OAuth MCP server                      |
|                           | Grafana           |                    |           |             |            |           |                                                          |
| CI/CD & Deployments       | CircleCI          |                    |           |             |            |           |                                                          |
|                           | Argo CD           |                    |           |             |            |           | Self-hosted, so each install has its own host            |
|                           | GitHub Actions    | `github`           |           |             |            |           | May extend the GitHub entry (to check)                   |
|                           | Buildkite         |                    |           |             |            |           |                                                          |
|                           | Vercel            | `vercel`           | API key   |             |            |           |                                                          |
| Product & Design          | Figma             |                    |           |             |            |           |                                                          |
|                           | Miro              |                    |           |             |            |           |                                                          |
|                           | Productboard      |                    |           |             |            |           |                                                          |
|                           | Dovetail          |                    |           |             |            |           |                                                          |
|                           | Canva             | `canva`            | OAuth     |             |            |           |                                                          |
| CRM                       | Salesforce        | `salesforce`       | OAuth     |             |            |           |                                                          |
|                           | HubSpot           |                    |           |             |            |           |                                                          |
|                           | Attio             |                    |           |             |            |           |                                                          |
| Payments                  | Stripe            |                    |           |             |            |           |                                                          |
| Customer Support          | Zendesk           |                    |           |             |            |           |                                                          |
|                           | Intercom          |                    |           |             |            |           |                                                          |
|                           | ServiceNow        |                    |           |             |            |           |                                                          |
| Cloud Infrastructure      | AWS               |                    | Cloud IAM |             |            |           | Needs a broker change                                    |
|                           | GCP               |                    | Cloud IAM |             |            |           | Needs a broker change                                    |
|                           | Azure             |                    | Cloud IAM |             |            |           | Needs a broker change                                    |
|                           | Cloudflare        |                    |           |             |            |           |                                                          |
| Data & Analytics          | Snowflake         |                    |           |             |            |           | Possibly API key or key pair (to check)                  |
|                           | BigQuery          |                    |           |             |            |           |                                                          |
|                           | Databricks        |                    |           |             |            |           |                                                          |
| Security & Identity       | Okta              |                    |           |             |            |           |                                                          |
|                           | Wiz               |                    |           |             |            |           |                                                          |
|                           | Snyk              |                    |           |             |            |           |                                                          |
| Business Operations       | Workday           |                    |           |             |            |           |                                                          |
|                           | NetSuite          |                    |           |             |            |           |                                                          |
|                           | SAP               |                    |           |             |            |           |                                                          |

**GitHub Enterprise.** Enterprise Cloud organizations live on github.com, so
the `github` entry should already cover them. Enterprise Server and GHE.com
(data residency) run on their own hosts. The GitHub adapter only calls
github.com and api.github.com, so these need their own entry and an adapter
that takes a host.

## Exploring a vendor

Start here before picking a pattern. Answer from the vendor's own docs and link
them in the issue.

| Question                                                         | What the answer tells you                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Does the vendor host a remote MCP server?                        | Yes: likely the vendor MCP pattern, mostly a catalog entry                   |
| Does its OAuth offer dynamic client registration?                | Yes: nothing to register. No: the operator registers an app; add a setup doc |
| Is there an official CLI that reads a token from an env var?     | The vendor CLI pattern: pin its release and allow-list its commands          |
| Is the only credential an API key or service account?            | No fit yet. Open an issue to discuss before writing code                     |
| How long do access tokens live? Do refresh tokens rotate?        | Sets the entry's token lifetime and refresh mode                             |
| Is there an endpoint that returns a stable account id?           | Needed to tell one person's accounts apart                                   |
| Can read-only access be granted on its own?                      | If yes, offer a read-only level too. If not, one level is fine               |
| Which tools or scopes delete data, act as admin or span the org? | Leave them out, or justify each one                                          |
| Is it cloud-only, or also self-hosted?                           | Self-hosted means a host per install, which may need catalog support         |
| Do calls cost money or send data somewhere new?                  | Note it under security in the issue                                          |
| Is there a free or trial account?                                | Without one, nobody can test the PR by hand. Say so                          |

## Security guidelines

Every connector follows these. Each issue repeats the ones that apply to it.

1. **The token never reaches the coding tool.** It is never in the tool's env,
   args or files. The session host makes the vendor calls. No path around this.
2. **A grant is an on/off switch.** A person connects their own account once,
   then turns each service on or off for each of their agents. On, the agent
   uses that account and acts as the person. Off stops new access; a token
   already handed out lasts until it expires. The skill tells the agent this.
3. **Ask for the least access that works.** No admin, org-wide or delete
   scopes without a written reason. If the vendor can grant read-only access on
   its own, offer it as a separate level; it is optional.
4. **Keep OAuth strict.** HTTPS only, PKCE S256, no new redirect hosts. Don't
   loosen the loader's checks.
5. **CLIs run without a shell.** Allow-list the first argument. Deny auth,
   profile, config and admin commands. Use only the vendor's official release,
   pinned by SHA-256.
6. **No real data in the repo.** No tokens, tenant or site URLs, account ids or
   customer data in fixtures or screenshots. Use `fake_vendor` and
   placeholders.
7. **Logos are the official mark**, reduced to a viewBox and paths, and credited
   in `NOTICE.md`.
8. **Rollback is one line.** Setting `enabled: false`, or adding the slug to
   `DISABLED_SERVICES`, switches a connector off.
9. **Vulnerabilities go to a [GitHub security advisory](../SECURITY.md)**,
   never a public issue.

## Sources

- **Design:** [service-connections-v2.md](design/service-connections-v2.md)
  (catalog v3, tokens, sessions, grants, not yet) and
  [service-connections-v1.md](design/service-connections-v1.md) (broker,
  grants, redaction)
- **Examples:** [catalog/atlassian/](../core/switch_core/connections/catalog/atlassian)
  (vendor MCP) and
  [catalog/google-workspace/](../core/switch_core/connections/catalog/google-workspace)
  (vendor CLI)
- **Tests:** [connections/](../core/tests/switch_core/connections) and
  [test_connection_catalog.py](../core/tests/switch_core/gateway/test_connection_catalog.py)
- **Logos:** [images/connections/](../console/apps/switch-console-desktop/src/assets/images/connections),
  [NOTICE.md](../console/apps/switch-console-desktop/src/assets/images/connections/NOTICE.md)
  and the colour in
  [connection-icon.tsx](../console/apps/switch-console-desktop/src/renderer/features/switch-servers/connection-icon.tsx)
- **Contributing:** [CONTRIBUTING.md](../CONTRIBUTING.md) and
  [SECURITY.md](../SECURITY.md)
