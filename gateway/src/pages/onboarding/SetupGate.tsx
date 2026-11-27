import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type LicenseAcceptance,
  type TeamSurvey,
  fetchLicenseAcceptance,
  fetchTeamSurvey,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { GATEWAY_ONBOARDING } from "../../data/featureFlags";
import { PRIMARY_BUTTON } from "../auth/AuthLayout";
import CenteredCard from "./CenteredCard";
import { LicenseStep } from "./License";
import TeamSurveyStep from "./TeamSurveyStep";

interface Steps {
  survey: TeamSurvey;
  license: LicenseAcceptance;
  // Whether the person had not answered the survey when the page loaded: this
  // is their first time through, so the steps are shown as part of signing up.
  firstTime: boolean;
}

/** Where the dashboard onboards people, asks each person once about their
 * team, and to accept the license once per version of it, before anything
 * else. Elsewhere, shows the dashboard as it is. */
export default function SetupGate({ children }: { children: ReactNode }) {
  const { capabilities } = useAuth();
  if (capabilities.features[GATEWAY_ONBOARDING] !== true) return <>{children}</>;
  return <FirstRunSteps>{children}</FirstRunSteps>;
}

function FirstRunSteps({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<Steps | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([fetchTeamSurvey(), fetchLicenseAcceptance()]).then(
      ([survey, license]) => setSteps({ survey, license, firstTime: survey.answers === null }),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(load, [load]);

  if (error !== null)
    return (
      <CenteredCard title="Something went wrong" subtitle="Switch couldn't check whether your account is set up.">
        <div className="flex flex-col gap-5">
          <Alert variant="destructive">{error}</Alert>
          <Button className={PRIMARY_BUTTON} onClick={load}>
            Try again
          </Button>
        </div>
      </CenteredCard>
    );
  if (steps === null)
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  if (steps.survey.answers === null)
    return <TeamSurveyStep survey={steps.survey} onAnswered={(survey) => setSteps({ ...steps, survey })} />;
  if (steps.license.accepted_version !== steps.license.version)
    return (
      <LicenseStep
        signingUp={steps.firstTime}
        onAccepted={(license) => setSteps({ ...steps, license })}
      />
    );
  return <>{children}</>;
}
