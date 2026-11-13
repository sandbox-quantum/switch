import { Alert } from "@mui/material";

/** What both layouts' organization Users say above the table: why the
 * platform operator sees nothing, or may only make an admin; and, where the
 * members come from the organization's account settings (a directory such as
 * WorkOS), what changing them here does. */
export default function OrganizationUsersNotices({
  asOperator,
  lockedOut,
  error,
  loaded,
  fromDirectory,
  directoryTakesChanges,
}: {
  asOperator: boolean;
  // The operator, while the organization has an admin: nothing to manage.
  lockedOut: boolean;
  error: string | null;
  // The members were read, so what is said about them stands.
  loaded: boolean;
  fromDirectory: boolean;
  directoryTakesChanges: boolean;
}) {
  return (
    <>
      {lockedOut ? (
        <Alert severity="info">
          As platform operator you can manage this organization's users only while it has no
          admin, to make someone one.
        </Alert>
      ) : (
        error && <Alert severity="error">{error}</Alert>
      )}
      {asOperator && !lockedOut && loaded && (
        <Alert severity="warning">
          {fromDirectory
            ? "This organization has no admin. Its admins come from its account settings, so " +
              "someone has to be made an organization admin there."
            : "This organization has no admin. As platform operator you can make one of its " +
              "users an admin; the change is recorded in its audit log, marked as yours."}
        </Alert>
      )}
      {fromDirectory && directoryTakesChanges && !asOperator && (
        <Alert severity="info">
          This organization's users, and who is its admin, come from your organization's
          account settings. Changes you make here are made there too; you may be asked to
          confirm your sign-in there first. New people can't be added from here yet: add them
          there.
        </Alert>
      )}
      {fromDirectory && !directoryTakesChanges && !asOperator && (
        <Alert severity="info">
          This organization's users, and who is its admin, come from your organization's
          account settings. Add people and make someone an organization admin there; the change
          shows here shortly. Removing someone here, or making an admin a member, takes effect at
          once but lasts only while the account settings agree: they are read again at the
          person's next sign-in and once a day. Make the same change there to keep it.
        </Alert>
      )}
    </>
  );
}
