# Organizations kept in WorkOS

By default a Switch server keeps its own record of organizations and their
members (`ORGANIZATION_DIRECTORY=local`). With `ORGANIZATION_DIRECTORY=workos`
the members of an organization, and who is its Org Admin, come from an
organization in a WorkOS environment instead. This is still being built and is
off by default; this page says what works today and what does not yet.

## What you need

- `ORGANIZATION_DIRECTORY=workos`
- `WORKOS_API_KEY`: an API key of the WorkOS environment (`WORKOS_API_URL`
  defaults to `https://api.workos.com`). With changes made from Switch (below),
  create it under the AuthKit application in `WORKOS_CLIENT_ID`: WorkOS
  exchanges an application's sign-ins only with that application's own key,
  and the same key reads organizations, memberships, users and events.
- The gateway signing people in through the same environment's AuthKit
  (`GATEWAY_SIGN_IN_PROVIDER=workos`, see
  [`GATEWAY_OIDC_SETUP.md`](GATEWAY_OIDC_SETUP.md)), which shares the person's
  sign-in with the environment's other applications. The server refuses to
  start with the directory and any other sign-in, a WorkOS Connect
  application included. Identities are kept under the fixed name
  `https://api.workos.com/user_management`, and the sign-in's subject is the
  person's WorkOS user id. The password form is off by default here; see the
  table in `GATEWAY_OIDC_SETUP.md`. Accounts are WorkOS users:
  `switch-accounts create` is refused, and a person joins an organization by
  its invitation.
- `GATEWAY_SIGNUP_MODE=invite_only` or `open`; the server refuses to start
  with `default_tenant`. Under `invite_only` nobody but the operator creates
  an organization. Under `open` someone may create one (up to
  `GATEWAY_MAX_WORKSPACES_PER_USER`). With `MEMBERS_SERVICE_URL` set it is
  created in WorkOS too and linked at once (see Creating an organization);
  without, it is Switch's own until an operator links it (below).

With the Helm chart (`deploy/remote/helm/switch`), set
`switchCore.organizationDirectory.mode: workos` and `secrets.workosApiKey`
(or `WORKOS_API_KEY` in `secrets.existingSecret`), next to `switchCore.oidc`
and `switchCore.signIn.provider: workos`, and `switchCore.signup.mode`
(`invite_only` or `open`); the settings for changes made from Switch (below)
are under `switchCore.organizationDirectory` too. The render fails on a
combination the server would refuse.

## Linking

Nothing is linked automatically. An operator links each Switch organization to
the one WorkOS organization it follows, and links existing accounts to their
WorkOS users, with `switch-link-workos` (run where switch-core runs, with the
same configuration):

```
switch-link-workos organization <switch organization id> <WorkOS organization id>
switch-link-workos accounts            # report only
switch-link-workos accounts --apply    # write the links
```

Two flags are for moving a server:

- `accounts --from-issuer <issuer>` links each account that signs in under
  that issuer (the server's sign-in before the move, such as a WorkOS Connect
  application's `https://<slug>.authkit.app` before AuthKit) to the same
  WorkOS user, where this environment has it. Its identity there is copied,
  not moved, so the old sign-in keeps working until the move is deployed.
  Run it with the settings the server signs in with after the move. An
  account with no identity under that issuer is linked by address as usual.
  The issuer must be spelt exactly as the old sign-in's identities are kept
  (a trailing slash counts): one no account signs in under is refused, with
  the issuers that are in use.
- `organization ... --replace` re-links an organization that already follows
  one WorkOS organization to another, for a server moving to another WorkOS
  environment, whose organizations have other ids there. Each switch-core
  process follows the new one once it next starts.

- **Organizations.** Only the linked WorkOS organization counts: being in, or
  `org_admin` of, any other WorkOS organization, even one beneath the same
  customer, gives nothing in Switch. A WorkOS organization's metadata never
  links it. The link is recorded in the organization's audit log.
- **Accounts.** Signing in through WorkOS never joins an existing Switch
  account by email address; someone whose address already has an account is
  refused until it is linked. `accounts` links an account when exactly one
  WorkOS user has its address, verified, and that user is linked to no other
  account, and reports every account it could not link and why. Accounts it
  cannot link can be handled by hand or left to sign in as new people once
  their old account is removed.

## At sign-in

When someone signs in, Switch reads their WorkOS memberships and, for each
linked organization:

- adds them if WorkOS lists them and Switch does not, with WorkOS's role
  (`org_admin` is Org Admin; every other WorkOS role is Member);
- makes them Org Admin if WorkOS has them as `org_admin` and Switch as Member.

Both are recorded in the organization's audit log. If WorkOS cannot be read,
or Switch's rows cannot be written, the sign-in goes ahead with Switch's rows
as they were, and the failure is logged. A sign-in never takes anything away;
the mirror does.

## Roles

Switch reads the WorkOS role `org_admin` as Org Admin and every other role as
Member, so an environment needs a role with that slug for anyone to be an Org
Admin.

It expects the other roles to be `admin`, `editor` or `viewer`. A membership
with any other role is still a Member, so nobody loses access over a role name,
but Switch logs it at `warning`, with the WorkOS membership and organization.

## The mirror

One switch-core process follows WorkOS's Events API, every 30 seconds, for
changes to a linked organization's memberships, and applies them. It starts
from when it first runs; once a day, and whenever it starts, it also compares
every linked organization's members with WorkOS and applies the difference,
which catches up anything from before it ran or missed since. It keeps its
place in the database, so a restart resumes where it stopped.

A change that fails to apply is tried again on the next pass, up to five
times. It is then passed over, and that organization is checked in full on
every pass until the check succeeds, so one stuck change doesn't hold up the
rest. If WorkOS no longer has the events from where the mirror stopped (it
keeps 90 days), the mirror starts again from now, records that in the
server's audit log, and checks every linked organization in full.

The process running the mirror reports three gauges, read when its metrics
are collected (`docs/old/observability.md`):

- `switch.workos.cursor_age`: seconds since a pass last read the events
  through. Up to 30 s is normal. It grows while passes fail, while WorkOS
  refuses where the mirror reads from, and while one event keeps failing,
  which is when a removal made in WorkOS isn't reaching Switch.
- `switch.workos.recheck.oldest_age`: how long the longest-waiting
  organization has been in the full recheck, 0 when none waits.
- `switch.workos.full_check.age`: seconds since every linked organization
  was last checked in full.

Only that process reports them, so no reading means no process is running
the mirror. `deploy/observability/monitors.json` alerts on each; import those
monitors with `WORKOS_DIRECTORY=1` (see its README).

For each person it matches (by the WorkOS user their account signs in as):

- **Added or made `org_admin` in WorkOS:** added, or made Org Admin, as at
  sign-in.
- **No longer `org_admin`:** made a Member. What they held in workspaces they
  stood in only as Org Admin (personal API keys, service connections,
  sign-ins under way) is removed.
- **Removed:** removed from the organization and from each of its workspaces,
  with their personal API keys, service connections and sign-ins under way
  there.

Each change is recorded in the organization's audit log, and each workspace
change in that workspace's. WorkOS is the record, so a change is applied even
when it breaks a rule Switch otherwise keeps. It is then logged at `error` and
recorded in the organization's audit log as "WorkOS change broke a Switch
rule", naming what:

- the organization's last Org Admin was removed or demoted;
- agents the person owns were left in place, owned by someone who can no
  longer act there, for an admin to delete. Each agent keeps its own key,
  which acts as the agent, never as the person; every key of the person's
  own goes;
- a workspace was left with no owner (its organization's Org Admins still
  administer it).

Someone WorkOS lists who has never signed in to Switch is added when they
first do. A member with no WorkOS identity (an account nobody linked) can't be
compared, and is logged and left. Deleting a linked organization in WorkOS
removes nobody, since one event would take away a whole organization. It is
logged at `error`, recorded in the organization's audit log, counted in
`switch.workos.organization_deleted` (which has its own monitor), and the
mirror stops following the organization: it is no longer checked against
WorkOS, now or after a restart. The link stays, since the admins' notice
(below) reads it. What happens next is an operator's call (see "When a
customer leaves").

The organization's admins see what is still wrong at the top of its
Organization page, until it is fixed: no admin (shown to the platform
operator, who may then make one), a workspace with no owner, agents whose
owner can no longer act for them, and a linked WorkOS organization that was
deleted. The audit log keeps the history.

## Changes made from Switch

When several products share one WorkOS environment, one service usually owns
each customer's account there, and every product changes its members through
it, so its rules (nobody grants above their own role, the last `org_admin`
stays) apply once for all of them. Switch can send its changes to such a
service, with `MEMBERS_SERVICE_URL`:

- Switch calls it, with the admin's token, `PATCH /v1/auth/tenants/members/{id}`
  with `{"role": <slug>}` and `DELETE /v1/auth/tenants/members/{id}`, each
  acting on the organization the token was issued for, and reads a refusal's
  `{"error": ...}`. The membership `id` is WorkOS's, which Switch reads with
  its API key.
- The token is the admin's own, from the AuthKit application people sign in
  through (`WORKOS_CLIENT_ID`), so the service must accept that
  application's tokens.

Then, on a linked organization, making a member Org Admin makes them
`org_admin` in WorkOS, making an Org Admin a Member makes them `viewer`
there, and removing someone removes their membership there, so each change
lasts. Switch first reads the person's membership from WorkOS and sends only
what WorkOS needs: someone WorkOS already has as `org_admin` is not made one
again, someone it holds in another product's role keeps that role when made
a Member, and someone it no longer lists, or who has no WorkOS identity, is
changed in Switch alone.

Switch uses no credential of its own for the change itself. Each sign-in
through AuthKit keeps its refresh token, encrypted, with the record of the
person's AuthKit session; when a change has to reach WorkOS, Switch renews
from it an access token for that organization alone, good for minutes, and
keeps the refresh token WorkOS rotates it to. Nothing reaches the browser,
and the admin never signs in a second time. Ending the session (signing out,
a revoke, `switch-accounts sign-out`) ends the refresh token with it. When
WorkOS won't renew it, because the session has ended there or the
organization wants its own way of signing in (single sign-on, MFA), the
dashboard sends the admin through the sign-in again, to that organization,
and makes the change on their return; a session that ended at WorkOS ends
in Switch too. Switch's own checks still run first; the service may refuse
by its own rules, and its reason is shown. If a demotion or removal has
already taken away the person's workspace access when a sign-in is needed,
the dashboard says so before sending the admin to sign in again to finish.
If the service refuses a token that has not run out, it is not set up to
accept this AuthKit application's tokens: Switch answers 503, says to make
the change in the account settings, and logs an error, rather than sending
the admin to sign in again. A platform operator restoring an Org Admin is no
admin there: unless WorkOS already has that person as `org_admin`, they are
told to have someone made one in the organization's account settings.

## Inviting people

With `MEMBERS_SERVICE_URL` set, an Org Admin invites people to a linked
organization through the service, with their own token as above:
`POST /organizations/current/invitations` with an e-mail address and
`member` or `org_admin` becomes the service's `POST
/v1/auth/tenants/invitations`, inviting a Member as WorkOS's `viewer` and an
Org Admin as `org_admin`. WorkOS sends the e-mail. `GET`, `POST
…/{id}/resend` and `DELETE …/{id}` list, resend and revoke them. Each is
recorded in the organization's audit log, and the service keeps its own rules
(nobody invites above their own role, one pending invitation per address).
For the link in the e-mail to open Switch rather than another product, the
service has to send Switch's invitations with Switch's own AuthKit
application key, and that application's User invitation URL in the WorkOS
dashboard has to be Switch's `/gateway/auth/oidc/login`, which hands the
invitation on to AuthKit. The e-mail's look is set once for the whole
environment.

Accepting signs the person in. Switch brings in their membership at sign-in,
as for anyone the organization has in WorkOS. In an organization with one
workspace, joining the organization joins its workspace too, as a member, and
leaving the organization takes them out of it again. An organization linked
earlier with several workspaces leaves where people work to its admins.

Invitations to one of a workspace's own links, which Switch sends itself,
still can't add someone new to a linked organization: accepting one is
refused with "Accept the email invitation to this organization first."

In the dashboard, Organization settings › Users invites through the
organization's account settings wherever they take changes: Invite users
asks for the e-mail address and a role (Viewer or Org Admin; Org Admin warns
that the person also becomes Org Admin in Switch Trust, with billing
permissions), and the pending invitations are listed below the users, each
to resend or revoke. What the service refuses is shown in its words, and an
admin whose sign-in to the organization has to be done again is offered it.
An organization whose members are Switch's own keeps its workspace invite
links.

## Creating an organization

With `MEMBERS_SERVICE_URL` set, an organization someone creates in Switch
(`POST /organizations`, the dashboard's onboarding) is created through the
service first, with the creator's own token renewed from their sign-in as
above, on no organization yet: `POST /v1/auth/tenants` with `{"name": ...}`
creates the customer's account, a WorkOS organization with the creator its
`org_admin`, and answers its id. Switch reads that organization back with its
API key and links it at once: the customer id from its `tenant_id` metadata,
the WorkOS organization's own name, and the id of the one workspace the
service records in its `workspaces` metadata. The service creates one account
per person and answers a second request with the first, whatever its name, so
Switch uses the name WorkOS has, and refuses with 409, naming it, when it
already follows that organization. Creating an account can take a minute
while the service sets up the customer's resources; Switch waits up to 90
seconds. If Switch then can't create its own rows, nothing is taken back from
WorkOS (the service deletes no account): creating it again links the same
one.

A linked organization has exactly one workspace, as the other products
sharing the environment have it. It is created with the organization, named
`Default` whatever was asked, keeps the service's id for it
(`tenants.directory_workspace_id`), and can be renamed in Switch, which the
service does not hear of yet. Adding a workspace to a linked organization is
refused, and so is deleting its only workspace. An organization linked
earlier with several workspaces keeps them.

### Onboarding

The dashboard's onboarding follows suit (`organizations_in_directory` in
`GET /auth/session`). Someone signed in and in no organization yet who may
create one is asked what Switch Trust asks, "What's your organization
called?", held to the same rules (64 characters at most, no `"` or `\`), and
two optional questions, how many people work there and what they'll use
Switch for, which are kept on the organization (`setup_answers`). Someone who
may not create one is told they aren't in an organization yet, to ask an
admin, and offered to sign in again, which picks up an invitation or a
membership made meanwhile. With several organizations, the picker says
"Choose an organization", since each has its one workspace.

`GATEWAY_LICENSE_VERSION` (Helm: `switchCore.signup.licenseVersion`) asks for
a license before any organization is created, wherever organizations are
kept: onboarding shows it first, `POST /auth/license` records who accepted
which version and when (`license_acceptances`), and creating one is refused
until the caller has. A new version is asked of everyone who creates an
organization after it is set; joining one someone else created asks
nothing. The text shown is a placeholder until the final one is supplied.

## When a customer leaves

Deleting a customer's organization in WorkOS doesn't delete anything in
Switch. Remove the memberships in WorkOS before the organization, so the
mirror takes each person out as their membership goes. Once the WorkOS
organization is deleted, delete the Switch organization with
`switch-purge-organization`, run where switch-core runs and with its
configuration, naming it by that WorkOS organization's id:

```
switch-purge-organization org_01EXAMPLE                                  # dry run: what goes, what stays
switch-purge-organization org_01EXAMPLE --execute --request "REQUEST-1"  # delete it
```

The purge deletes the organization's workspaces, with their rooms, agents
and connections, and the accounts that belonged to nothing else. It keeps
the workspaces' audit history for the usual two years. If it exits 3, it is
waiting for something outside Switch; run the same command again later.
`docs/design/data-retention.md` says what it deletes and keeps.

## In the dashboard

On a linked organization's Organization page, the Members section says that
its members and Org Admins come from the organization's account settings
(WorkOS). With changes sent to WorkOS (above), it offers every change,
inviting someone new included ("Inviting people"), and says the admin may be asked to sign in again. Without, it does not offer making a member Org Admin; removing someone
or making an Org Admin a Member is still offered: it ends their access at
once, and the page says it lasts only until WorkOS is read again (their next
sign-in, or the daily check) unless the same change is made there. The
platform operator, on a linked organization with no admin, is told the admin
has to be made in WorkOS. A workspace's Invitations section says that only
people already in the organization can accept, since accepting can't add
anyone new to it.

## Not done yet

- **Without `MEMBERS_SERVICE_URL`, adding someone to a linked organization
  from Switch is refused**, from the dashboard or by invitation: add them in
  WorkOS. Making someone Org Admin is refused too, and a removal or demotion
  changes only Switch; whatever WorkOS still grants comes back at the next
  sign-in or check.
- Without `MEMBERS_SERVICE_URL`, a new organization created on the server,
  by an operator or by someone signing up under `open`, is Switch's own until
  it is linked.
- A workspace renamed in Switch keeps its old name in the service's records,
  which have no way to rename it yet.
