# Organizations: v1, a layer above workspaces

Status: proposed. Builds on the single workspace `admin` role (owner merged
into admin) and on the connector apps of
[`service-connections-v2.md`](service-connections-v2.md).

A company runs several Switch workspaces and wants to set things up once for
all of them: one GitHub App registered in its own GitHub organization, used by
every workspace, controlled by the company's admins rather than by whoever
runs the server. Today nothing sits above a workspace. A workspace is the
tenant every scoped row hangs off, and a connector app is one per deployment,
set up by the operator. This note adds an **organization**: the customer,
owning workspaces, its own admins, its own connector apps, and later its
billing.

## Where this is going

Three roles, the same on the hosted service and on a self-hosted server:

- **Org Admin**, over the whole organization: creates workspaces, manages
  people across them, registers connector apps, and in time sees the
  organization's audit log, usage, budgets, devices and billing, and sets its
  guardrails and which connectors workspaces may use.
- **Workspace Admin**, over one workspace: its members, rooms, agents,
  messaging apps, templates, budgets and audit log, and which of the
  organization's connectors are on.
- **Member**, over their own: agents, connections and grants, rooms they
  create, their own devices.

"Organization" replaces "server" wherever a person sees it. The hosted
service's operator sits above every organization and is not an Org Admin of
any of them.

This note builds only what is hard to add later: the organization itself,
the authorization around it, the identity it shares with other products, and
the first thing an organization owns (connector apps). Everything else in the
list above is a route and a screen on top, listed under Later.

## Decisions

- **An organization owns workspaces.** Every workspace belongs to exactly one
  organization. Workspaces keep their own members and roles.
- **Roles.** Organization: `org_admin` and `member`. Workspace: `admin` and
  `member`, as today. Shown as "Org Admin", "Workspace Admin" and "Member".
- **An Org Admin administers every workspace of the organization**, without a
  membership row in it.
- **Joining a workspace makes you a member of its organization.**
- **Anyone signed in may create an organization** and becomes its Org Admin.
  **Only an Org Admin creates workspaces** in it.
- **The platform operator may act in any workspace, and every time they do,
  the workspace's audit log says so.** The operator flag never makes anyone
  an Org Admin or a workspace member.
- **On a self-hosted server** the operator named in `GATEWAY_ADMIN_EMAIL` is
  the Org Admin of the server's first organization, so a server with one
  organization works as it does today.
- **Identity.** On the hosted service an organization is a WorkOS
  organization: the customer's root organization, in a WorkOS environment
  shared with other products. WorkOS says which organization a person belongs
  to and whether they are its `org_admin`. Switch decides everything inside:
  which workspaces, and which role there. A server without WorkOS keeps
  organizations in its own database (the local directory).
- **The organization is what billing attaches to.** It carries the customer's
  id as the other products know it, and an allowance is kept per
  organization, never per workspace.
- **Connector apps per organization.** Every connector whose app the server
  registers at the vendor can instead use an app the organization registered:
  GitHub's App first, then every OAuth client with `registration: static`.
- **Switches.** A Workspace Admin can still switch a service off for their
  workspace. An Org Admin can switch a service on or off for the whole
  organization, and lock it so workspaces cannot change it.
- **The dashboard is where organizations are administered.** Every
  organization, workspace and admin control is in the gateway dashboard.
  Switch Console gets one only where it cannot do without it.

## Naming

In Switch the word *tenant* means a workspace: `tenant_id` on every scoped
row, `tenant_members`, `require_tenant_admin`. In the WorkOS environment, and
in the other products sharing it, a tenant is the customer, an organization.
Renaming every `tenant_id` is out of scope, so:

- Every new API route, JSON field, UI label and log field says
  `organization` or `workspace`, never `tenant`.
- Existing columns keep `tenant_id`, which means workspace. New columns are
  `organization_id`.
- Organization routes live under `/gateway/organizations/…`.
- "Admin" on the dashboard's Users page, which means the operator today,
  becomes "Platform operator".

## Data model

```
organizations
  id                      text pk
  slug                    text unique
  name                    text
  workos_organization_id  text unique null   -- the root organization; null under the local directory
  customer_id             text unique null   -- the customer's id as WorkOS and billing know it
  created_at              timestamptz

tenants
  + organization_id       text not null  -> organizations.id

organization_members
  organization_id  text  -> organizations.id
  user_id          text  -> users.id
  role             text  check (role in ('org_admin', 'member'))
  pk (organization_id, user_id)

organization_app_credentials        -- same shape as service_app_credentials
  organization_id, service, client_id, settings, encrypted_secrets,
  updated_by, updated_at, created_at
  pk (organization_id, service)

organization_service_settings
  organization_id, service, enabled bool, locked bool, updated_by, updated_at
  pk (organization_id, service)

organization_audit_events           -- same rules as audit_events
```

`customer_id` is the key billing and the other products use for the customer.
It is constant across a customer's root organization and any child
organizations the other products make under it, so it, not a token's
`org_id`, is what identifies the customer. Under the local directory it is
null.

`organization_members` is written by Switch under the local directory and
mirrors WorkOS under the WorkOS directory (below). Either way it is what
authorization reads, so no request waits on WorkOS.

**Row-level security.** The `after_begin` hook (`db/tenant_session.py`) binds
the workspace today. It also binds the workspace's organization, read
from `tenants` when the request is resolved. Organization-scoped tables get a
policy on `organization_id`, the same fail-closed way as workspace-scoped ones:
nothing bound, nothing read. A route acting on an organization with no
workspace in hand (creating a workspace, the organization's settings) binds
only the organization.

**Migration.** Expand: create the tables, give every existing workspace an
organization of its own (same name, a derived slug), make its admins
`org_admin` and every other member a `member`, fill
`tenants.organization_id`. Contract, in a later release: `NOT NULL` on
`tenants.organization_id`. Nothing is merged automatically: a company that
already has several workspaces has them moved under one organization
deliberately (see Later).

## Authorization

`authz.administers_tenant` is the one function that turns a role into the
admin bit every `Principal.is_admin` is built from. It becomes:

```
administers_workspace    = workspace_role == "admin"
                           or org_role == "org_admin"     -- of the workspace's organization
administers_organization = org_role == "org_admin"
```

Every route behind `require_tenant_admin`, and `authz.can`'s admin
short-circuit, follow without change. Agents keep acting as their owner, so an
agent owned by an Org Admin administers what its owner does, in the workspace
its request is bound to. Grants are untouched: the broker and the grant
routes never consult the admin bit, so nobody, admins included, grants
someone else's connection.

**Entering a workspace.** Resolving a request's workspace
(`gateway/auth.py`, `_resolve_tenant_id`) today requires a membership row. An
Org Admin may also bind any workspace of their organization. They hold no
`tenant_members` row there: the members page lists them as "Org Admin, via
the organization", and losing `org_admin` loses the access at once, with
nothing left behind to clean up. Code that assumes a bound user has a
membership row (`is_tenant_member` and its callers) is audited as part of
this work. Creating an organization also makes its creator a Workspace Admin
of its first workspace, explicitly, so they are a member there in their own
right.

**Rules.**

- Nobody grants a role above their own. A Workspace Admin invites Workspace
  Admins and Members; only an Org Admin grants `org_admin`.
- The organization role is held on its own, never derived from workspace
  roles: deriving `org_admin` from Workspace Admin would make a workspace's
  admin the admin of every other workspace too. Joining a workspace makes
  someone a `member` of its organization if they are not one; changing or
  removing their workspace membership leaves their organization role alone.
  An Org Admin's admin rights over a workspace come from the organization,
  so the workspace members page refuses to demote or remove an Org Admin and
  points to the organization's members instead.
- The workspace members page lists every Org Admin, those with no membership
  row there marked "via the organization".
- Removing someone from an organization is refused while they still belong
  to any of its workspaces, naming them: leaving a workspace revokes their
  keys and connections there and refuses while they own agents, which is the
  workspace's own removal to do.
- The last Org Admin of an organization cannot be demoted or removed: 409,
  as the last Workspace Admin is refused today. Account deletion refuses the
  last Org Admin of an organization with other members.

### The platform operator

`users.role == "admin"` stays, renamed in the interface to "Platform
operator". It is a separate path through authorization, not part of the
admin bit:

```
platform_access = is_operator and not administers_workspace
```

- **Deployment routes.** The server's own connector apps, creating password
  accounts, server-wide trust settings, the official messaging apps: as
  today, behind `require_admin`.
- **Inside a workspace.** The operator may bind any workspace and acts there
  as its admin. Whenever that access comes from the operator flag alone, it
  is recorded in the workspace's `audit_events` as `platform_access`, with the
  operator, the route and the time: once when the operator enters the
  workspace, and for every write. Entering is `POST /tenants/{id}/switch`;
  signing in never selects a workspace the operator reaches only by the flag,
  so every visit starts with a recorded switch. A write is any request other
  than `GET`, `HEAD` and `OPTIONS`, recorded before the route runs, so an
  attempt that fails is recorded too. Workspace and Org Admins read it in the
  audit log they already have. Access the operator holds through an ordinary
  role (their own organization on a self-hosted server) is not marked.
- **Finding a workspace.** `GET /operator/workspaces` lists every workspace;
  `GET /tenants` stays the operator's own, so the ordinary picker never
  lists customers'. Listing records nothing; entering does.
- **Restoring an admin.** An organization with no Org Admin left gets one
  from the operator, recorded the same way.
- The operator never appears in a members list, and holds no membership row
  it did not get by invitation.

The dependency that binds every gateway request (`get_current_user`) decides
`platform_access` and writes the record, so it sits in one place and no
route can grant operator access without it.

## Creating organizations and workspaces

- `POST /gateway/organizations`: any signed-in user, allowed by
  `GATEWAY_SIGNUP_MODE`. The caller becomes Org Admin. The organization
  starts with one workspace, with the caller its Workspace Admin, and the
  session switches into it.
- `POST /gateway/organizations/current/workspaces`: Org Admin only. The
  creator becomes the new workspace's Workspace Admin too, so it stays theirs
  if they stop being Org Admin. The session stays where it is.
- Both count against the per-person allowance on workspaces created
  (`GATEWAY_MAX_WORKSPACES_PER_USER`), the platform operator exempt. An
  `invite_only` sign-up mode refuses creating an organization, but not an Org
  Admin adding a workspace: it decides who comes onto the server, not what an
  organization adds to itself.
- `GET /gateway/organizations`: the caller's organizations and their role in
  each, read through the workspaces they may enter. An organization they
  belong to without being in any of its workspaces is left out.
  `GET /gateway/organizations/current/workspaces`: every workspace for an
  Org Admin, only the caller's own for a member.
- Creating either is recorded in the new workspace's audit log.
- `POST /tenants` keeps working for one release, creating an organization and
  its first workspace, then goes.

Under the WorkOS directory, creating an organization is not Switch's to do
alone: the customer, its root WorkOS organization, its `customer_id` and its
billing record are created once for every product, by the service that owns
them, and the call is idempotent per creator. Switch asks that service, then
writes its own rows. A user who already belongs to a customer, created from
another product, gets no new organization: they land in theirs.

## Connector apps per organization

Which catalog entries this covers: GitHub's App and every OAuth client with
`registration: static` (Google Workspace, Airtable). Not `registration:
dynamic` (Atlassian), where Core registers itself with the vendor and the
vendor sees one Switch, and not keys, which are a person's own.

**Which app a workspace uses**, first found wins:

1. its organization's saved app (`organization_app_credentials`);
2. the server's configured app (`GITHUB_APP_CONFIG_PATH`,
   `<PREFIX>_CLIENT_CONFIG_PATH`);
3. the server's saved app (`service_app_credentials`).

"Configuration wins" still holds between 2 and 3. A server setting,
`ORGANIZATION_CONNECTOR_APPS`, switches step 1 off for a deployment that wants
one app per vendor. On a self-hosted server with one organization, the
operator's app and the organization's are the same thing seen from two
pages; the organization's page is the one to use.

**The broker.** Today `ConnectorApps.apply` rebuilds one adapter per service
and swaps it into the broker. That becomes a registry keyed by
(organization, service): an adapter is built the first time an organization's
workspace needs it and dropped when the organization's app changes, with the
existing `app_signals` announcement carrying the organization id. A workspace
whose organization has no app uses the server's adapter as today. This is the
largest change in the plan.

**Signing in.** The callback stays where it is
(`/gateway/provider-connections/github/callback` for GitHub, Core's generic
callback for OAuth), so an organization registers the same URL the server's
own app does. A sign-in flow is a workspace-scoped row: the callback reads
the workspace from it, then the organization, then that organization's app.
The flow records the client it started with, and a sign-in that straddles an
app replacement is refused, as it is today.

**Replacing an app.** `ServiceConnection.oauth_client_id` already tells a
connection made through a replaced client that it needs reconnecting. An
organization moving from the server's app to its own, or from one of its apps
to another, needs nothing new: each person reconnects once.

**Checks and secrets.** An organization's save goes through the same vendor
check (`connections/app_checks.py`) and the same encryption as the operator's,
and no response carries a secret. A save, replacement or removal is recorded
in `organization_audit_events`.

**Routes and UI.** `/gateway/organizations/current/connector-apps`, behind
`require_org_admin`, mirrors `/gateway/connector-apps`. The dashboard gets an
organization Connectors page, reusing the operator's dialogs; Switch Console
gets none. A workspace's Connectors page names which app it signs in through:
"your organization's" or "this server's".

**Rollout.** `ORGANIZATION_CONNECTOR_APPS` is off by default until the whole
phase has landed, so a deployment never runs half of it. Off, the
organization routes are not mounted and no workspace looks past the server's
apps.

## Switching services on and off

Whether a service is on for a workspace, first found wins:

1. the organization's setting, if `locked`;
2. the workspace's setting (`workspace_service_settings`);
3. the organization's setting, unlocked;
4. the workspace's default (`tenants.services_on_by_default`).

An organization's setting of off, locked, is the organization's allow-list.
A Workspace Admin's switch is shown disabled, with the reason, while the
organization has the service locked. Switching off keeps grants, as today.

## The WorkOS directory

Membership and roles go through one port, `OrganizationDirectory`, with two
implementations:

- **Local** (any server without WorkOS): Switch writes `organizations` and
  `organization_members` itself.
- **WorkOS** (the hosted service): organization membership and the
  `org_admin` role live in WorkOS; workspace membership and roles stay in
  Switch. WorkOS's events keep the mirror current.

**What Switch writes to WorkOS, and what it doesn't.** The WorkOS environment
is shared, and an API key for it is not limited to one product. Switch writes
no organization metadata and creates no organizations itself (see Creating
organizations). Adding an organization member and changing their role go
through the same owning service, so each product's rules on roles are
enforced in one place.

**Sign-in.** Switch has its own WorkOS Application: its own client id,
redirect and sign-out URLs. The session says who the person is and which
organization they signed in to. That organization may be one of the
customer's child organizations made by another product, so Switch resolves
the customer by `customer_id`, read from the organization, and finds or
creates its `organizations` row for it, reading the members from WorkOS. A
customer already using another product finds its organization and Org
Admins in place.

**Linking accounts.** Switch links a new sign-in to an existing account by
verified email today. In a user pool shared with other products that rule
is reviewed before the WorkOS directory is turned on: a WorkOS user id is the
link, and an email match alone never joins two accounts.

**Roles in WorkOS.** Roles are configured per environment and shared, and a
member holds one role per organization. Switch reads `org_admin` as Org Admin
and every other role as Member, so making someone Org Admin in Switch makes
them `org_admin` everywhere. Switch adds no role to WorkOS for workspace
roles, which WorkOS never sees. A role Switch does add one day is prefixed
`switch_`, and no shared slug is redefined.

**Rules on both paths.** The last-Org-Admin guard and "nobody grants above
their own role" run in Switch's own write path, and are checked again when an
event arrives. A change made elsewhere that breaks them is applied, because
WorkOS is authoritative, but it is logged as an error and shown to the
organization's admins.

## Phases

1. **Organizations, local directory.** The tables and migration, the new
   authorization, Org Admins entering workspaces, the platform operator's
   audited access, organization and workspace creation, organization members
   and the last-admin guard, "Organization" and "Platform operator" in the
   interface.
2. **Connector apps per organization.** GitHub first, then static OAuth
   clients. Storage, the broker registry, sign-in routing, organization
   switches and locks, UI, audit. Ships on the local directory.
3. **The WorkOS directory** for the hosted service: the Switch Application in
   the shared environment, sign-in resolved to the customer, the mirror and
   its events, organization creation and membership through the owning
   service, the account-linking review.

## Later

Each of these hangs off the organization and the roles above, so none needs
the model to change:

- Moving a workspace between organizations, merging organizations, archiving
  and deleting workspaces.
- Organization-wide views: the audit log across workspaces, usage, budgets,
  devices; Workspace Admins seeing their members' devices.
- Guardrail settings and messaging-app credentials per organization.
- Allowances from billing, kept per organization and checked where Switch
  spends (claiming a hosted machine first).
- Workspace Admins seeing who connected what, revoking a member's connection,
  and reconfiguring members' managed agents.
- Roles beyond `org_admin`, `admin` and `member`, and a catalog of permission
  strings.
- SSO connections, directory sync and domain verification per organization.
