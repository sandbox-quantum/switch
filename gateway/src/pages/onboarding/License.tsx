import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { useEffect, useState } from "react";
import { type LicenseAcceptance, type LicenseText, acceptLicense, fetchLicense } from "../../data/api";
import { PRIMARY_BUTTON, SignUpSteps } from "../auth/AuthLayout";
import CenteredCard from "./CenteredCard";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The license Switch is offered under, as the server ships it. */
export function useLicenseText(): { license: LicenseText | null; error: string | null } {
  const [license, setLicense] = useState<LicenseText | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchLicense().then(setLicense, (err: unknown) =>
      setError(`Couldn't load the license: ${message(err)}`),
    );
  }, []);
  return { license, error };
}

export function LicensePanel({ text }: { text: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label="License text"
      className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-black/10 bg-white/80 p-6 font-mono text-xs leading-relaxed text-neutral-800 dark:border-white/10 dark:bg-black/30 dark:text-neutral-200"
    >
      {text}
    </pre>
  );
}

/** Asks the signed-in person to accept the license, once per version of it. */
export function LicenseStep({
  signingUp,
  onAccepted,
}: {
  signingUp: boolean;
  onAccepted: (acceptance: LicenseAcceptance) => void;
}) {
  const { license, error } = useLicenseText();
  const [submitting, setSubmitting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const accept = async () => {
    if (license === null) return;
    setSubmitting(true);
    setAcceptError(null);
    try {
      onAccepted(await acceptLicense(license.version));
    } catch (err) {
      setAcceptError(`Couldn't record that you accepted the license: ${message(err)}`);
      setSubmitting(false);
    }
  };

  return (
    <CenteredCard
      title="Review the license"
      subtitle={
        signingUp
          ? "Switch is offered under this license. Read it, then accept it to get started."
          : "The license Switch is offered under has changed. Read it, then accept it to carry on."
      }
      width="xl"
    >
      {signingUp && <SignUpSteps active={3} />}
      <div className="flex flex-col gap-5">
        {(error ?? acceptError) && <Alert variant="destructive">{error ?? acceptError}</Alert>}
        {license ? <LicensePanel text={license.text} /> : !error && <Spinner className="mx-auto size-5" />}
        <Button className={PRIMARY_BUTTON} disabled={license === null || submitting} onClick={() => void accept()}>
          {submitting && <Spinner className="size-4" />}I have reviewed and accept the license
        </Button>
      </div>
    </CenteredCard>
  );
}
