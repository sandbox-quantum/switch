import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { useState } from "react";
import { type TeamSurvey, type TeamSurveyAnswers, answerTeamSurvey } from "../../data/api";
import { PRIMARY_BUTTON, SignUpSteps } from "../auth/AuthLayout";
import CenteredCard from "./CenteredCard";

const PILL =
  "cursor-pointer rounded-full border px-4 py-1.5 text-sm transition-colors aria-checked:border-neutral-900 aria-checked:bg-neutral-900 aria-checked:text-white dark:aria-checked:border-white dark:aria-checked:bg-white dark:aria-checked:text-neutral-900";
const PILL_OFF =
  "border-black/15 bg-white/70 text-neutral-700 hover:border-black/30 dark:border-white/15 dark:bg-white/5 dark:text-neutral-300 dark:hover:border-white/30";

function Choice({
  id,
  label,
  choices,
  value,
  onChange,
}: {
  id: string;
  label: string;
  choices: string[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={value === choice}
            className={`${PILL} ${value === choice ? "" : PILL_OFF}`}
            onClick={() => onChange(choice)}
          >
            {choice}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Tell us about your team": asked once, after the person has a workspace. */
export default function TeamSurveyStep({
  survey,
  onAnswered,
}: {
  survey: TeamSurvey;
  onAnswered: (survey: TeamSurvey) => void;
}) {
  const [companySize, setCompanySize] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [agentCount, setAgentCount] = useState<string | null>(null);
  const [useCases, setUseCases] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = companySize !== null && role !== null && agentCount !== null && useCases.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (companySize === null || role === null || agentCount === null || useCases.length === 0) return;
    setSubmitting(true);
    setError(null);
    const answers: TeamSurveyAnswers = {
      company_size: companySize,
      role,
      agent_count: agentCount,
      use_cases: useCases,
    };
    try {
      onAnswered(await answerTeamSurvey(answers));
    } catch (err) {
      setError(`Couldn't save your answers: ${err instanceof Error ? err.message : String(err)}`);
      setSubmitting(false);
    }
  };

  return (
    <CenteredCard
      title="Tell us about your team"
      subtitle="A few quick questions, so Switch can fit the way your team works."
      width="lg"
    >
      <SignUpSteps active={2} />
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-7">
        {error && <Alert variant="destructive">{error}</Alert>}
        <Choice
          id="company-size"
          label="Company size"
          choices={survey.choices.company_size}
          value={companySize}
          onChange={setCompanySize}
        />
        <Choice id="your-role" label="Your role" choices={survey.choices.role} value={role} onChange={setRole} />
        <Choice
          id="agent-count"
          label="Number of AI agents"
          choices={survey.choices.agent_count}
          value={agentCount}
          onChange={setAgentCount}
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-sm font-medium">Primary use cases</legend>
          {survey.choices.use_cases.map((useCase) => (
            <label
              key={useCase}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/10 bg-white/70 px-4 py-3 text-sm has-checked:border-neutral-900 dark:border-white/10 dark:bg-white/5 dark:has-checked:border-white"
            >
              <input
                type="checkbox"
                className="size-4 accent-neutral-900 dark:accent-white"
                checked={useCases.includes(useCase)}
                onChange={(e) =>
                  setUseCases((chosen) =>
                    e.target.checked ? [...chosen, useCase] : chosen.filter((each) => each !== useCase),
                  )
                }
              />
              {useCase}
            </label>
          ))}
        </fieldset>
        <Button type="submit" className={PRIMARY_BUTTON} disabled={!complete || submitting}>
          {submitting && <Spinner className="size-4" />}
          Continue
        </Button>
      </form>
    </CenteredCard>
  );
}
