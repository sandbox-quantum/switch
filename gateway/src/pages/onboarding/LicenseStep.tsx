import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../../data/AuthContext";
import { acceptLicense } from "../../data/api";
import AuthLayout, { SignedInFooter } from "../auth/AuthLayout";
import OnboardingSteps, { LICENSE_ACCEPTED_KEY, ONBOARDING_STEPS } from "./OnboardingSteps";

/** The license and accepting it. The text is a placeholder until the final
 * one is supplied; the server records who accepted which version, and when.
 * Accepting re-reads the session, which then no longer asks for it. */
export function LicenseAgreement({ version }: { version: string }) {
  const { refresh } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await acceptLicense(version);
      window.sessionStorage.setItem(LICENSE_ACCEPTED_KEY, version);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the license");
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box
        role="document"
        aria-label="Switch license"
        tabIndex={0}
        sx={{
          maxHeight: 220,
          overflowY: "auto",
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          p: 2,
          textAlign: "left",
        }}
      >
        <Typography variant="subtitle2" component="h2">
          Switch license (version {version})
        </Typography>
        <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
          The license text goes here. This is a placeholder until the final text is ready;
          accepting it records that you accepted this version, and when.
        </Typography>
      </Box>
      <FormControlLabel
        control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />}
        label="I have read and accept the license"
      />
      <Button
        variant="contained"
        fullWidth
        disabled={!agreed || submitting}
        onClick={() => void accept()}
        startIcon={submitting ? <CircularProgress size={16} /> : undefined}
      >
        Accept and continue
      </Button>
    </Stack>
  );
}

/** Onboarding's first step where a license is asked for, before the
 * organization is set up. */
export default function LicenseStep({ version }: { version: string }) {
  return (
    <AuthLayout
      title="Before you start"
      subtitle="Read and accept the Switch license to set up your organization."
      footer={<SignedInFooter />}
    >
      <Stack spacing={2}>
        <OnboardingSteps current={0} steps={ONBOARDING_STEPS} />
        <LicenseAgreement version={version} />
      </Stack>
    </AuthLayout>
  );
}
