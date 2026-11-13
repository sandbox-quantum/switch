import LockOutlined from "@mui/icons-material/LockOutlined";
import LogoutOutlined from "@mui/icons-material/LogoutOutlined";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  OutlinedInput,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useId, useState } from "react";
import EditableField from "../../components/EditableField";
import { useAuth } from "../../data/AuthContext";
import { type Me, changeMyName, fetchMe } from "../../data/api";
import ChangePasswordDialog from "../../layout/ChangePasswordDialog";
import { tokenVar } from "../../theme/tokens";
import DeleteAccountDialog from "./DeleteAccountDialog";

// What `PATCH /auth/me` accepts.
const NAME_MAX = 255;
// How wide the two fields are, as the design has them.
const FIELD_WIDTH = 360;

/** Your account: the signed-in person, not the workspace, and the same for
 * every role. The display name is edited in place and the email only shown,
 * since it is how the person signs in; under them, one card per thing to do
 * with the account. */
export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchMe()
      .then((read) => current && setMe(read))
      .catch((err) => current && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      current = false;
    };
  }, []);

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Your account
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        About you, not this workspace — the same in every workspace you're in.
      </Typography>
      {loadError ? (
        <Alert severity="error">Couldn't load your account: {loadError}</Alert>
      ) : me === null ? (
        <CircularProgress size={24} />
      ) : (
        <AccountSections me={me} onRenamed={setMe} />
      )}
    </Box>
  );
}

function AccountSections({ me, onRenamed }: { me: Me; onRenamed: (me: Me) => void }) {
  const { logout, logoutEverywhere, recheck } = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Kept after the message closes, so it still names them while it fades out.
  const [renamedTo, setRenamedTo] = useState("");
  const [noticeOpen, setNoticeOpen] = useState(false);
  // Which sign-out is under way. Both buttons wait for it: a sign-out that
  // fails says so here, and this browser stays signed in.
  const [signingOut, setSigningOut] = useState<"here" | "everywhere" | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // The session is read again for everywhere else the name shows.
  const rename = async (draft: string) => {
    const renamed = await changeMyName(draft);
    onRenamed(renamed);
    await recheck();
    setRenamedTo(renamed.name);
    setNoticeOpen(true);
  };

  // A sign-out that works leaves the page, so only a failure comes back here.
  const signOut = async (which: "here" | "everywhere") => {
    setSigningOut(which);
    setSignOutError(null);
    try {
      await (which === "here" ? logout() : logoutEverywhere());
    } catch (err) {
      const what = which === "here" ? "Couldn't sign out" : "Couldn't sign out of every device";
      setSignOutError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      setSigningOut(null);
    }
  };

  return (
    <>
      <Stack spacing={2.5}>
        <EditableField
          label="Display name"
          value={me.name}
          canEdit
          readOnlyHelper=""
          editLabel="Change display name"
          maxLength={NAME_MAX}
          width={FIELD_WIDTH}
          onSave={rename}
        />
        <ReadOnlyField label="Email" value={me.email} />
      </Stack>

      <Stack spacing={2} sx={{ mt: 4 }}>
        {/* An account made through single sign-on has no password here. */}
        {me.has_password && (
          <AccountCard
            title="Password"
            description="Change the password you sign in with. Other devices are signed out."
            error={null}
          >
            <Button
              variant="outlined"
              startIcon={<LockOutlined />}
              onClick={() => setPasswordOpen(true)}
            >
              Change password
            </Button>
          </AccountCard>
        )}
        <AccountCard
          title="Sign out"
          description="Ends this browser session, or every session you have open. Your agents keep running."
          error={signOutError}
        >
          <Button
            variant="text"
            onClick={() => void signOut("everywhere")}
            disabled={signingOut !== null}
            loading={signingOut === "everywhere"}
          >
            Sign out of all devices
          </Button>
          <Button
            variant="outlined"
            startIcon={<LogoutOutlined />}
            onClick={() => void signOut("here")}
            disabled={signingOut !== null}
            loading={signingOut === "here"}
          >
            Sign out
          </Button>
        </AccountCard>
        <AccountCard
          title="Delete account"
          description="Removes you from every workspace you're in, and deletes the agents you own and the connector accounts you connected."
          error={null}
        >
          <Button variant="outlined" color="error" onClick={() => setDeleteOpen(true)}>
            Delete account
          </Button>
        </AccountCard>
      </Stack>

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <DeleteAccountDialog
        open={deleteOpen}
        email={me.email}
        onClose={() => setDeleteOpen(false)}
      />
      <Snackbar
        open={noticeOpen}
        autoHideDuration={5000}
        onClose={() => setNoticeOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Alert severity="success" onClose={() => setNoticeOpen(false)}>
          Display name changed to {renamedTo}.
        </Alert>
      </Snackbar>
    </>
  );
}

/** A value nobody can change here, drawn as the design system draws one:
 * the cream fill, the border kept, no shadow, still selectable. The email is
 * how the person signs in, so it needs no caption saying so. */
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  return (
    <FormControl sx={{ maxWidth: FIELD_WIDTH }} fullWidth>
      <InputLabel htmlFor={id}>{label}</InputLabel>
      <OutlinedInput
        id={id}
        value={value}
        readOnly
        size="small"
        sx={{
          backgroundColor: tokenVar("field-readonly"),
          boxShadow: "none",
          "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: tokenVar("field-border") },
        }}
      />
    </FormControl>
  );
}

/** One thing to do with the account: what it is on the left, its buttons on
 * the right, and under them why the last attempt failed, if it did. */
function AccountCard({
  title,
  description,
  error,
  children,
}: {
  title: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      aria-label={title}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 2,
        p: 2,
        border: `1px solid ${tokenVar("border")}`,
        borderRadius: "16px",
        backgroundColor: tokenVar("widget"),
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
      </Box>
      <Stack direction="row" sx={{ gap: 1, flexShrink: 0 }}>
        {children}
      </Stack>
      {error && (
        <Alert severity="error" sx={{ flexBasis: "100%", overflowWrap: "anywhere" }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
