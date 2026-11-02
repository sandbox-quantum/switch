# Organizations kept in WorkOS

By default a Switch server keeps its own record of organizations and their
members (`ORGANIZATION_DIRECTORY=local`). With `ORGANIZATION_DIRECTORY=workos`
the members of an organization, and who is its Org Admin, come from an
organization in a WorkOS environment instead. This is still being built and is
off by default; this page says what works today and what does not yet.

## What you need

- `ORGANIZATION_DIRECTORY=workos`
- `WORKOS_API_KEY`: an API key of the WorkOS environment (`WORKOS_API_URL`
  defaults to `https://api.workos.com`).
- The gateway's OIDC sign-in (`GATEWAY_OIDC_*`, see
  [`GATEWAY_OIDC_SETUP.md`](GATEWAY_OIDC_SETUP.md)) set up against an AuthKit
  application of the same environment. The sign-in's subject is the person's
  WorkOS user id.
- `GATEWAY_SIGNUP_MODE=invite_only`. Organizations cannot be created in WorkOS
  from Switch yet, so nobody but the operator creates one; the server refuses
  to start with any other mode.

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
as they were, and the failure is logged.

## Not done yet

- **Removals and demotions are not applied.** If someone is removed from the
  linked WorkOS organization, or is no longer its `org_admin`, Switch keeps
  their membership and role, and with them their access. Each sign-in by that
  person logs it at `error`. Until this is built, an Org Admin ends such
  access in Switch as well, from the organization's Members page: removing a
  member and taking Org Admin away are allowed on a linked organization, and
  change only Switch. Whatever WorkOS still grants comes back at the person's
  next sign-in.
- **Granting from Switch is refused** for a linked organization: adding a
  member (from the dashboard or by invitation) or making one Org Admin. Make
  those changes in WorkOS.
- A new organization created on the server is Switch's own until it is linked.
