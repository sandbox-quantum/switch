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
- The gateway's OIDC sign-in (`GATEWAY_OIDC_*`, see
  [`GATEWAY_OIDC_SETUP.md`](GATEWAY_OIDC_SETUP.md)) set up against an AuthKit
  application of the same environment. The sign-in's subject is the person's
  WorkOS user id. `GATEWAY_OIDC_ISSUER_URL` must be exactly the issuer the
  tokens name, trailing slash included: Switch looks people's WorkOS
  identities up under it, so a sign-in whose token names another issuer is
  refused, and the log says which one it named.
- `GATEWAY_SIGNUP_MODE=invite_only`. Organizations cannot be created in WorkOS
  from Switch yet, so nobody but the operator creates one; the server refuses
  to start with any other mode.

With the Helm chart (`deploy/remote/helm/switch`), set
`switchCore.organizationDirectory.mode: workos` and `secrets.workosApiKey`
(or `WORKOS_API_KEY` in `secrets.existingSecret`), next to `switchCore.oidc`
and `switchCore.signup.mode: invite_only`; the settings for changes made from
Switch (below) are under `switchCore.organizationDirectory` too. The render
fails on a combination the server would refuse.

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
removes nobody: it is logged and recorded for an operator to deal with.

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
service. Set all three, or none:

- `MEMBERS_SERVICE_URL`: the service. Switch calls, with the admin's token,
  `PATCH /v1/auth/tenants/members/{id}` with `{"role": <slug>}` and
  `DELETE /v1/auth/tenants/members/{id}`, each acting on the organization
  the token was issued for, and reads a refusal's `{"error": ...}`. The
  membership `id` is WorkOS's, which Switch reads with its API key.
- `WORKOS_CLIENT_ID`: the AuthKit application Switch signs admins in to for
  that token.
- `WORKOS_REDIRECT_URL`: its callback, `.../gateway/auth/workos/callback`,
  registered on that application.

Then, on a linked organization, making a member Org Admin makes them
`org_admin` in WorkOS, making an Org Admin a Member makes them `viewer`
there, and removing someone removes their membership there, so each change
lasts. Switch first reads the person's membership from WorkOS and sends only
what WorkOS needs: someone WorkOS already has as `org_admin` is not made one
again, someone it holds in another product's role keeps that role when made
a Member, and someone it no longer lists, or who has no WorkOS identity, is
changed in Switch alone. Switch uses no credential of its own for the change
itself: the first time an admin makes one WorkOS needs, the dashboard sends them to sign in to the organization
through the AuthKit application (usually without a prompt, while their
AuthKit session lasts) and makes the change on their return. Switch keeps the
access token that sign-in gives, encrypted in the browser's short-lived
sign-in cookie, only for as long as the token lasts, and keeps no refresh
token. A sign-in as another WorkOS user than the one the Switch account signs
in as, or to another organization, is refused. Switch's own checks still run
first; the service may refuse by its own rules, and its reason is shown. If
the token runs out after a demotion or removal has already taken away the
person's workspace access, the dashboard says so before sending the admin to
sign in again to finish. If the service refuses a token that has not run
out, it is not set up to accept this AuthKit application's tokens: Switch
answers 503, says to make the change in the account settings, and logs an
error, rather than sending the admin to sign in again. A platform operator restoring an Org Admin can't
sign in there: unless WorkOS already has that person as `org_admin`, they are
told to have someone made one in the organization's account settings.

Adding someone new to a linked organization from Switch is still refused.

## In the dashboard

On a linked organization's Organization page, the Members section says that
its members and Org Admins come from the organization's account settings
(WorkOS). With changes sent to WorkOS (above), it offers every change but
adding someone, and says the admin may be asked to confirm their sign-in
there. Without, it does not offer making a member Org Admin; removing someone
or making an Org Admin a Member is still offered: it ends their access at
once, and the page says it lasts only until WorkOS is read again (their next
sign-in, or the daily check) unless the same change is made there. The
platform operator, on a linked organization with no admin, is told the admin
has to be made in WorkOS. A workspace's Invitations section says that only
people already in the organization can accept, since accepting can't add
anyone new to it.

## Not done yet

- **Adding someone to a linked organization from Switch is refused**, from
  the dashboard or by invitation: add them in WorkOS. Without changes sent to
  WorkOS (above), making someone Org Admin is refused too, and a removal or
  demotion changes only Switch; whatever WorkOS still grants comes back at
  the next sign-in or check.
- A new organization created on the server is Switch's own until it is linked.
