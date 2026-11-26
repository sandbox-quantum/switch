import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Input } from "@switch-console/chat-ui/primitives/input";
import { Label } from "@switch-console/chat-ui/primitives/label";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { oidcSignInButtons } from "@switch-console/chat-ui/model/sign-in-options";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { brandSvg } from "../../components/connectors/brandMarks";
import {
  type AuthConfig,
  createTenant,
  fetchAuthConfig,
  oidcLoginUrl,
  signUp as createAccount,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { readPendingInvite } from "../../data/sessionState";
import { LicensePanel, useLicenseText } from "../onboarding/License";
import AuthLayout, {
  CARD_INPUT,
  CARD_LABEL,
  OUTLINE_BUTTON,
  OrDivider,
  PRIMARY_BUTTON,
  SignUpSteps,
  TEXT_LINK,
} from "./AuthLayout";

/** What a new person's workspace is called until they name it. */
export function suggestedWorkspaceName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? `${first}'s workspace` : "My workspace";
}

/** The sign-in provider's mark, for the providers Switch has one for. */
function ProviderMark({ label }: { label: string }) {
  const slug = /google/i.test(label) ? "google-workspace" : /github/i.test(label) ? "github" : null;
  const svg = slug === null ? undefined : brandSvg(slug);
  if (svg === undefined) return <KeyRound aria-hidden />;
  // A bundled logo, not anything a person typed.
  return <span aria-hidden className="inline-flex size-4" dangerouslySetInnerHTML={{ __html: svg }} />;
}

type Step = "start" | "password" | "workspace";

export default function LoginPage() {
  const { login, signUp, refresh } = useAuth();
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<Step>("start");
  const [accountMade, setAccountMade] = useState(false);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [readingLicense, setReadingLicense] = useState(false);

  useEffect(() => {
    fetchAuthConfig().then(setAuthConfig, (err: unknown) =>
      console.warn("Could not read how Switch signs people in here; offering password sign-in", err),
    );
  }, []);

  // Default to showing the password form if the config call hasn't resolved
  // (or failed) so password login always remains reachable.
  const passwordLoginEnabled = authConfig?.password_login_enabled ?? true;
  const oidcEnabled = authConfig?.oidc_enabled ?? false;
  const oidcButtons = oidcSignInButtons(
    authConfig?.oidc_login_options ?? [],
    authConfig?.oidc_provider_label ?? null,
  );
  const canSignUp = passwordLoginEnabled && authConfig?.web_signup_enabled === true;
  // Under open sign-up a new account joins no workspace, so it names its own.
  const ownWorkspace = canSignUp && authConfig?.signup_mode === "open";
  const oidcOpensAccounts = oidcEnabled && authConfig?.signup_mode === "open";
  const name = `${firstName.trim()} ${lastName.trim()}`.trim();
  const workspaceName = workspace ?? suggestedWorkspaceName(name);

  const goTo = (next: Step) => {
    setStep(next);
    setError(null);
  };

  const switchMode = (toCreating: boolean) => {
    setCreating(toCreating);
    setPassword("");
    goTo("start");
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (step === "start") {
        goTo("password");
        return;
      }
      if (step === "password" && creating && ownWorkspace) {
        goTo("workspace");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        if (step === "workspace") {
          if (!accountMade) {
            await createAccount({ email, password, display_name: name || null });
            setAccountMade(true);
          }
          try {
            await createTenant(workspaceName.trim());
          } catch (err) {
            throw new Error(
              `Your account was created, but not your workspace: ${err instanceof Error ? err.message : "it could not be created"}`,
            );
          }
          await refresh();
        } else if (creating) await signUp({ email, password, name: name || null });
        else await login(email, password);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : creating
              ? "Your account could not be created"
              : "Login failed",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [step, creating, accountMade, ownWorkspace, workspaceName, name, email, password, login, signUp, refresh],
  );

  if (readingLicense) return <LicenseReader onBack={() => setReadingLicense(false)} />;

  const subheading =
    step === "workspace"
      ? "Name your workspace: where your agents, rooms and teammates live. You can rename it later."
      : creating
        ? undefined
        : readPendingInvite()
          ? "Sign in to accept your invitation."
          : !canSignUp && oidcOpensAccounts
            ? "New to Switch? Signing in creates your account, and you can create a workspace or join one."
            : undefined;

  const submitLabel =
    step === "start"
      ? creating
        ? "Continue"
        : "Continue with email"
      : step === "password"
        ? creating
          ? ownWorkspace
            ? "Continue"
            : "Create account"
          : "Sign in"
        : accountMade
          ? "Create workspace"
          : "Create account";

  return (
    <AuthLayout
      heading={creating ? "Sign up for Switch" : "Sign in to Switch"}
      subheading={subheading}
      footer={
        creating && (
          <>
            By creating an account, you agree to the{" "}
            <button type="button" className="cursor-pointer underline underline-offset-2" onClick={() => setReadingLicense(true)}>
              license
            </button>
          </>
        )
      }
    >
      {creating && ownWorkspace && <SignUpSteps active={step === "workspace" ? 1 : 0} />}
      <div className="flex flex-col gap-5">
        {error && <Alert variant="destructive">{error}</Alert>}
        {(passwordLoginEnabled || step !== "start") && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5" key={step}>
            {step === "start" && creating && (
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="first-name" className={CARD_LABEL}>
                    First name
                  </Label>
                  <Input
                    id="first-name"
                    className={CARD_INPUT}
                    placeholder="Your first name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    autoFocus
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="last-name" className={CARD_LABEL}>
                    Last name
                  </Label>
                  <Input
                    id="last-name"
                    className={CARD_INPUT}
                    placeholder="Your last name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                  />
                </div>
              </div>
            )}
            {step === "start" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="email" className={CARD_LABEL}>
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  className={CARD_INPUT}
                  placeholder="Your email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  autoFocus={!creating}
                  required
                />
              </div>
            )}
            {step === "password" && (
              <>
                <div className="flex h-10 items-center justify-between gap-3 rounded-md border border-black/10 bg-white/50 px-3 text-sm dark:border-white/10 dark:bg-white/5">
                  <span className="truncate">{email}</span>
                  <button type="button" className={TEXT_LINK} onClick={() => goTo("start")}>
                    Change
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password" className={CARD_LABEL}>
                    Password
                  </Label>
                  <Input
                    id="password"
                    type="password"
                    className={CARD_INPUT}
                    placeholder={creating ? "Choose a password" : "Your password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={creating ? "new-password" : "current-password"}
                    autoFocus
                    required
                  />
                </div>
              </>
            )}
            {step === "workspace" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="workspace-name" className={CARD_LABEL}>
                  Workspace name
                </Label>
                <Input
                  id="workspace-name"
                  className={CARD_INPUT}
                  value={workspaceName}
                  onChange={(e) => setWorkspace(e.target.value)}
                  required
                  autoFocus
                />
              </div>
            )}
            <Button
              type="submit"
              className={PRIMARY_BUTTON}
              disabled={submitting || (step === "workspace" && workspaceName.trim() === "")}
            >
              {submitting && <Spinner className="size-4" />}
              {submitLabel}
            </Button>
            {step === "workspace" && !accountMade && (
              <Button variant="ghost" disabled={submitting} onClick={() => goTo("password")}>
                Back
              </Button>
            )}
          </form>
        )}
        {step === "start" && passwordLoginEnabled && oidcEnabled && <OrDivider />}
        {step === "start" && oidcEnabled && (
          <div className="flex flex-col gap-3">
            {oidcButtons.map((option) => (
              <Button
                key={option.id ?? "sso"}
                variant="outline"
                className={OUTLINE_BUTTON}
                onClick={() => {
                  window.location.href = oidcLoginUrl(option.id);
                }}
              >
                <ProviderMark label={option.label} />
                {`Continue with ${option.label}`}
              </Button>
            ))}
          </div>
        )}
        {step === "start" && canSignUp && (
          <p className="text-center text-sm text-neutral-700 dark:text-neutral-300">
            {creating ? "Already have an account? " : "Don't have an account? "}
            <button type="button" className={TEXT_LINK} onClick={() => switchMode(!creating)}>
              {creating ? "Sign in" : "Sign up"}
            </button>
          </p>
        )}
      </div>
    </AuthLayout>
  );
}

function LicenseReader({ onBack }: { onBack: () => void }) {
  const { license, error } = useLicenseText();
  return (
    <AuthLayout heading="The Switch license" width="xl">
      <div className="flex flex-col gap-5">
        {error && <Alert variant="destructive">{error}</Alert>}
        {license ? <LicensePanel text={license.text} /> : !error && <Spinner className="mx-auto size-5" />}
        <Button className={PRIMARY_BUTTON} onClick={onBack}>
          Back to sign up
        </Button>
      </div>
    </AuthLayout>
  );
}
