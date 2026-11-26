import { Box, Stack, Typography } from "@mui/material";

/** The steps of onboarding where a license is asked for first. */
export const ONBOARDING_STEPS = ["License", "Organization"];

/** Set in the tab once the license is accepted there, for the next step to
 * show where it stands. */
export const LICENSE_ACCEPTED_KEY = "switch.licenseAccepted";

/** Where in onboarding someone is: one dot per step, the current one wider,
 * and its name. */
export default function OnboardingSteps({ current, steps }: { current: number; steps: string[] }) {
  return (
    <Stack spacing={1} sx={{ alignItems: "center" }}>
      <Stack direction="row" spacing={0.75} aria-hidden>
        {steps.map((step, i) => (
          <Box
            key={step}
            sx={{
              width: i === current ? 22 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: i <= current ? "text.primary" : "divider",
              transition: "width 150ms",
            }}
          />
        ))}
      </Stack>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        Step {current + 1} of {steps.length}: {steps[current]}
      </Typography>
    </Stack>
  );
}
