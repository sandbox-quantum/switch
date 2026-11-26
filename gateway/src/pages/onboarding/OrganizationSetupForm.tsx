import {
  Alert,
  Button,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import {
  DIRECTORY_ORGANIZATION_NAME_MAX,
  TEAM_SIZES,
  type TeamSize,
  needsOrganizationSignIn,
  oidcLoginUrl,
  setUpOrganization,
} from "../../data/api";

/** What makes a name the organization's account can't take, as it would
 * say it; null for one it takes. The same rules the account service checks,
 * so a name is refused here rather than after a minute of setting up. */
export function organizationNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  if ([...trimmed].length > DIRECTORY_ORGANIZATION_NAME_MAX) {
    return `Use ${DIRECTORY_ORGANIZATION_NAME_MAX} characters or fewer.`;
  }
  if (/["\\]/.test(trimmed)) return 'Leave out double quotes (") and backslashes (\\).';
  return null;
}

/** Setting up the organization where organizations are kept in the account
 * every Switch product shares: its name, as Switch Trust asks it, and two
 * optional questions about it. Creating it there can take up to a minute;
 * the server then switches the session into its one workspace (it re-mints
 * the cookie), so success reloads into the app. */
export default function OrganizationSetupForm() {
  const [name, setName] = useState("");
  const [teamSize, setTeamSize] = useState<TeamSize | "">("");
  const [useCase, setUseCase] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The account asked for a fresh sign-in before it creates anything.
  const [signInAgain, setSignInAgain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const problem = organizationNameProblem(name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSignInAgain(false);
    try {
      await setUpOrganization(name.trim(), {
        team_size: teamSize === "" ? null : teamSize,
        use_case: useCase.trim() === "" ? null : useCase.trim(),
      });
      window.location.assign("/");
    } catch (err) {
      setSignInAgain(needsOrganizationSignIn(err));
      setError(err instanceof Error ? err.message : "Could not set up the organization");
      setSubmitting(false);
    }
  };

  return (
    <Stack component="form" onSubmit={submit} spacing={2}>
      {error && (
        <Alert
          severity="error"
          action={
            signInAgain ? (
              <Button color="inherit" size="small" href={oidcLoginUrl(null, "/")}>
                Sign in again
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}
      <TextField
        label="What's your organization called?"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="My Organization"
        error={problem !== null}
        helperText={problem ?? "You can change it later."}
        disabled={submitting}
        required
        autoFocus
      />
      <TextField
        select
        label="How many people work there?"
        value={teamSize}
        onChange={(e) => setTeamSize(e.target.value as TeamSize | "")}
        disabled={submitting}
        helperText="Optional"
      >
        <MenuItem value="">
          <em>Rather not say</em>
        </MenuItem>
        {TEAM_SIZES.map((size) => (
          <MenuItem key={size.value} value={size.value}>
            {size.label}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label="What will you use Switch for?"
        value={useCase}
        onChange={(e) => setUseCase(e.target.value)}
        disabled={submitting}
        helperText="Optional"
        multiline
        minRows={2}
        slotProps={{ htmlInput: { maxLength: 500 } }}
      />
      <Button
        type="submit"
        variant="contained"
        fullWidth
        disabled={submitting || name.trim() === "" || problem !== null}
        startIcon={submitting ? <CircularProgress size={16} /> : undefined}
      >
        Get started
      </Button>
      {submitting && (
        <Typography variant="body2" role="status" sx={{ color: "text.secondary" }}>
          Setting up your organization. This can take up to a minute.
        </Typography>
      )}
    </Stack>
  );
}
