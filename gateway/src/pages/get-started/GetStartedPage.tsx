import "../chats/chat.css";
import { BuddyFace } from "@switch-console/chat-ui/components/buddy-face";
import { BuddyStartCard } from "@switch-console/chat-ui/components/buddy-start-card";
import { MeetBuddyIntro } from "@switch-console/chat-ui/components/meet-buddy-intro";
import {
  OnboardingSurface,
  type WizardExit,
} from "@switch-console/chat-ui/components/onboarding-surface";
import {
  ProviderActionPanel,
  ProviderChoiceCard,
} from "@switch-console/chat-ui/components/provider-choice";
import {
  SetupChecklist,
  type SetupStageState,
} from "@switch-console/chat-ui/components/setup-checklist";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import type { ProviderLogin } from "@switch-console/chat-ui/model/seal-login";
import {
  VERTEX_DEFAULT_REGION,
  vertexLoginCredential,
} from "@switch-console/chat-ui/model/vertex-login";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { SegmentedControl } from "@switch-console/chat-ui/primitives/segmented-control";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { fetchAuthConfig } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { type Controller, cloudMachineLifecycle } from "../../data/management";
import {
  WEB_PROVIDERS,
  type WebProvider,
  buddyOf,
  createBuddy,
  giveMachineLogin,
  loginOutcome,
  needsWaking,
  startOver,
  wakeCloudMachine,
  welcomeChat,
} from "./onboarding";
import { forgetGetStartedVisit } from "./CloudWarmUp";
import { ProviderIcon } from "./ProviderIcon";
import { type CloudSnapshot, deviceReady, useCloudDevice } from "./useCloudDevice";

/** How long setting up runs before the page says a long one is expected. */
const LONG_SETUP_MS = 30_000;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function providerName(provider: WebProvider): string {
  return WEB_PROVIDERS.find((each) => each.provider === provider)!.label;
}

/** A provider the device reports signed in, among those offered here. */
function signedIn(controller: Controller | null, provider: WebProvider): boolean {
  return (controller?.status?.providers ?? []).some(
    (each) => each.provider === provider && each.installed && each.auth === "ok",
  );
}

/** Why the device says the provider's login does not work, or null while it has not said. */
function loginProblem(controller: Controller | null, provider: WebProvider): string | null {
  const status = (controller?.status?.providers ?? []).find((each) => each.provider === provider);
  if (!status || status.auth_source !== "sealed" || status.auth === "ok") return null;
  if (status.auth !== "expired") return null;
  return status.auth_problem ?? `${providerName(provider)} did not sign in with that login.`;
}

type Page =
  | { kind: "meet" }
  | { kind: "provider"; error: string | null }
  | { kind: "setting-up"; provider: WebProvider; login: ProviderLogin | null };

/**
 * Getting started on Switch Cloud from the web: Console's first run, page for
 * page. Meet switch-buddy, pick the AI provider it runs on, and Switch sets it
 * up, then its Welcome chat opens.
 *
 * The person's cloud device is never asked about: it starts as they arrive,
 * and setting up waits for it. A login can only be sealed to the device once
 * it runs (it is sealed to the device's own key), so what is pasted is held
 * here, in this page's memory alone, until then.
 */
export default function GetStartedPage() {
  const { user, session, logout } = useAuth();
  const tenantId = session?.tenant?.id ?? null;
  const navigate = useNavigate();
  const { snapshot, error, refresh } = useCloudDevice();
  const [page, setPage] = useState<Page>({ kind: "meet" });
  const firstName = user?.name?.split(/\s+/)[0] || null;
  const exit: WizardExit = { label: "Finish later", onExit: () => navigate("/") };
  const buddy = buddyOf(snapshot?.agents);
  const [testServer, setTestServer] = useState(false);
  useEffect(() => {
    fetchAuthConfig().then(
      (config) => setTestServer(config?.test_account_reset_enabled === true),
      () => setTestServer(false),
    );
  }, []);

  const openChat = useCallback(
    async (agent: { agentId: string; name: string }) => {
      const roomId = await welcomeChat({
        agentId: agent.agentId,
        agentName: agent.name,
        firstName,
      });
      navigate(
        `/chats/agents/${encodeURIComponent(agent.agentId)}?chat=${encodeURIComponent(roomId)}`,
      );
    },
    [firstName, navigate],
  );
  const refused = useCallback((reason: string) => setPage({ kind: "provider", error: reason }), []);
  const person = useMemo(
    () => ({ name: user?.name ?? null, email: user?.email ?? null }),
    [user?.name, user?.email],
  );

  return (
    <div className={SHARED_UI_CLASS} style={{ height: "100vh" }}>
      {page.kind === "meet" ? (
        <MeetPage
          exit={exit}
          firstName={firstName}
          snapshot={snapshot}
          readError={error}
          existing={buddy ? { agentId: buddy.agent_id, name: buddy.name } : null}
          onOpen={openChat}
          onStart={(provider) => setPage({ kind: "setting-up", provider, login: null })}
          onSetUp={() => setPage({ kind: "provider", error: null })}
          onSkip={() => navigate("/")}
          testServer={testServer}
          onStartOver={async () => {
            await startOver({
              buddyId: buddy?.agent_id ?? null,
              controller: snapshot?.controller ?? null,
              machine: snapshot?.machine ?? null,
            });
            // Signed out, so signing in again goes through getting started from the top.
            if (user && tenantId) forgetGetStartedVisit(user.id, tenantId);
            await logout();
          }}
        />
      ) : page.kind === "provider" ? (
        <ProviderPage
          exit={exit}
          snapshot={snapshot}
          error={page.error}
          onBack={() => setPage({ kind: "meet" })}
          onSkip={() => navigate("/")}
          onStart={(provider, login) => setPage({ kind: "setting-up", provider, login })}
        />
      ) : (
        <SettingUpPage
          exit={exit}
          snapshot={snapshot}
          refresh={refresh}
          readError={error}
          provider={page.provider}
          login={page.login}
          person={person}
          onRefused={refused}
          onCreated={openChat}
        />
      )}
    </div>
  );
}

function BuddyHeader() {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-[22%] bg-background-tertiary">
        <BuddyFace size={38} expression={{ blink: false, smile: false }} />
      </span>
      <h1 className="mt-2 text-2xl font-semibold">Meet switch-buddy</h1>
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start justify-center gap-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Meet switch-buddy: who it is, in its own lines, and how to start it. */
function MeetPage({
  exit,
  firstName,
  snapshot,
  readError,
  existing,
  onOpen,
  onStart,
  onSetUp,
  onSkip,
  testServer,
  onStartOver,
}: {
  exit: WizardExit;
  firstName: string | null;
  snapshot: CloudSnapshot | null;
  readError: string | null;
  existing: { agentId: string; name: string } | null;
  onOpen: (agent: { agentId: string; name: string }) => Promise<void>;
  onStart: (provider: WebProvider) => void;
  onSetUp: () => void;
  onSkip: () => void;
  /** On a test server, getting started can be started over with the same account. */
  testServer: boolean;
  onStartOver: () => Promise<void>;
}) {
  const introPlayed = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const unavailable = snapshot?.available === false;

  const open = (agent: { agentId: string; name: string }) => {
    setOpening(true);
    setOpenError(null);
    onOpen(agent).catch((caught: unknown) => {
      setOpening(false);
      setOpenError(message(caught, "Your chat with switch-buddy could not be opened."));
    });
  };

  const main = existing ? (
    <Button onClick={() => open(existing)} disabled={opening}>
      {opening && <Spinner className="size-3.5" />}
      Open switch-buddy
    </Button>
  ) : unavailable ? (
    <Button variant="outline" onClick={onSkip}>
      Continue
    </Button>
  ) : null;
  const somethingToReset =
    existing !== null ||
    (snapshot?.controller?.status?.providers ?? []).some((each) => each.auth_source === "sealed");
  const resetNow = () => {
    setResetting(true);
    setResetError(null);
    onStartOver().then(
      () => {
        setResetting(false);
        setConfirming(false);
      },
      (caught: unknown) => {
        setResetting(false);
        setResetError(message(caught, "Getting started could not be started over."));
      },
    );
  };
  const footer =
    testServer && somethingToReset ? (
      <>
        {main}
        <Button variant="ghost" onClick={() => setConfirming(true)} disabled={resetting}>
          Start over
        </Button>
      </>
    ) : (
      main
    );
  const signedInHere = WEB_PROVIDERS.filter(({ provider }) =>
    signedIn(snapshot?.controller ?? null, provider),
  ).map(({ provider, label }) => ({ id: provider, name: label }));

  return (
    <OnboardingSurface exit={exit} enter={introPlayed.current} footer={footer}>
      <MeetBuddyIntro
        firstName={firstName}
        here="the dashboard"
        play={!introPlayed.current}
        onPlayed={() => {
          introPlayed.current = true;
        }}
        after={
          existing || unavailable ? null : (
            <BuddyStartCard
              checking={snapshot === null}
              ready={signedInHere}
              starting={null}
              onStart={(id) => onStart(id as WebProvider)}
              onSetUp={onSetUp}
              onSkip={onSkip}
              icon={(id, size) => <ProviderIcon provider={id as WebProvider} size={size} />}
              readyTag="Signed in on Switch Cloud"
              info={null}
            />
          )
        }
      />
      {unavailable && !existing && (
        <p className="text-center text-sm text-foreground-muted">
          Switch has no cloud devices for this workspace, so switch-buddy needs a computer of your
          own. Add one under Devices.
        </p>
      )}
      {confirming && (
        <div className="mx-auto flex max-w-[540px] flex-col items-center gap-3 rounded-xl border border-border bg-background p-4 text-center">
          <p className="text-sm text-foreground">
            Start getting started over? switch-buddy is deleted, the AI sign-ins given to your
            Switch Cloud are taken back, and it is stopped. For testing only.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={resetting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={resetNow} disabled={resetting}>
              {resetting && <Spinner className="size-3.5" />}
              Yes, start over
            </Button>
          </div>
          {resetError && <Alert>{resetError}</Alert>}
        </div>
      )}
      {readError && <Alert>{readError}</Alert>}
      {openError && <Alert>{openError}</Alert>}
    </OnboardingSurface>
  );
}

/** What a provider's card says: signed in on Switch Cloud already, or what it takes. */
function providerTag(provider: WebProvider, controller: Controller | null): string {
  if (signedIn(controller, provider)) return "Signed in on Switch Cloud";
  return provider === "claude" ? "Setup token, API key or Vertex AI" : "API key";
}

/** Pick the AI provider switch-buddy runs on, and give its login. */
function ProviderPage({
  exit,
  snapshot,
  error,
  onBack,
  onSkip,
  onStart,
}: {
  exit: WizardExit;
  snapshot: CloudSnapshot | null;
  /** Why the last login did not work, from setting up. */
  error: string | null;
  onBack: () => void;
  onSkip: () => void;
  onStart: (provider: WebProvider, login: ProviderLogin | null) => void;
}) {
  const controller = snapshot?.controller ?? null;
  const [selected, setSelected] = useState<WebProvider | null>(null);
  return (
    <OnboardingSurface
      exit={exit}
      footer={
        <>
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </>
      }
    >
      <BuddyHeader />
      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground">Pick an AI provider to power switch-buddy:</p>
        <ul className="grid gap-3 sm:grid-cols-3">
          {WEB_PROVIDERS.map(({ provider, label }) => (
            <ProviderChoiceCard
              key={provider}
              icon={<ProviderIcon provider={provider} size={28} />}
              name={label}
              tag={providerTag(provider, controller)}
              tone={signedIn(controller, provider) ? "ready" : "plain"}
              selected={selected === provider}
              disabled={false}
              onSelect={() => setSelected(provider)}
            />
          ))}
        </ul>
        {selected && (
          <ProviderActionPanel providerId={selected}>
            {signedIn(controller, selected) ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    Use the {providerName(selected)} sign-in it already has
                  </p>
                  <p className="text-xs text-foreground-muted">
                    switch-buddy runs on Switch Cloud with the {providerName(selected)} login given
                    to it before.
                  </p>
                </div>
                <div>
                  <Button onClick={() => onStart(selected, null)}>
                    Start with {providerName(selected)}
                  </Button>
                </div>
              </>
            ) : (
              <LoginForm provider={selected} onStart={(login) => onStart(selected, login)} />
            )}
            {error && <Alert>{error}</Alert>}
          </ProviderActionPanel>
        )}
        {error && !selected && <Alert>{error}</Alert>}
      </div>
    </OnboardingSurface>
  );
}

/** `text`, with what is between backticks shown as code. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-background-tertiary px-1">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-foreground";

/** The login to give the provider: what is pasted or picked here, checked before anything is sent. */
function LoginForm({
  provider,
  onStart,
}: {
  provider: WebProvider;
  onStart: (login: ProviderLogin) => void;
}) {
  const choice = WEB_PROVIDERS.find((each) => each.provider === provider)!;
  const [kind, setKind] = useState<ProviderLogin["kind"]>(choice.kinds[0]!.kind);
  const shown = choice.kinds.find((each) => each.kind === kind) ?? choice.kinds[0]!;
  const [credential, setCredential] = useState("");
  const [project, setProject] = useState("");
  const [region, setRegion] = useState(VERTEX_DEFAULT_REGION);
  const [googleFile, setGoogleFile] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const vertex = shown.kind === "vertex";
  const ready = vertex
    ? googleFile !== null && project.trim() !== "" && region.trim() !== ""
    : credential.trim() !== "";

  const start = () => {
    setError(null);
    try {
      onStart(
        vertex
          ? {
              kind: "vertex",
              credential: vertexLoginCredential({
                project,
                region,
                googleCredentials: googleFile?.text ?? "",
              }),
            }
          : { kind: shown.kind, credential: credential.trim() },
      );
    } catch (caught) {
      setError(message(caught, "That login cannot be used."));
    }
  };

  return (
    <>
      {choice.kinds.length > 1 && (
        <SegmentedControl
          value={shown.kind}
          onChange={setKind}
          ariaLabel="How it signs in"
          className="self-start"
          options={choice.kinds.map((each) => ({ value: each.kind, label: each.label }))}
        />
      )}
      <p className="text-xs text-foreground-muted">
        <WithCode text={shown.hint} />
      </p>
      {vertex ? (
        <>
          <div className="flex gap-2">
            <label className="flex-1 space-y-1 text-xs text-foreground-muted">
              <span>Google Cloud project</span>
              <input
                aria-label="Google Cloud project"
                placeholder="my-gcp-project"
                className={INPUT_CLASS}
                value={project}
                onChange={(event) => setProject(event.target.value)}
              />
            </label>
            <label className="w-32 space-y-1 text-xs text-foreground-muted">
              <span>Region</span>
              <input
                aria-label="Region"
                className={INPUT_CLASS}
                value={region}
                onChange={(event) => setRegion(event.target.value)}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => picker.current?.click()}>
              Choose JSON file
            </Button>
            <input
              ref={picker}
              hidden
              type="file"
              accept="application/json,.json"
              aria-label="Google credential file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void file.text().then(
                  (text) => setGoogleFile({ name: file.name, text }),
                  () => setError(`${file.name} could not be read.`),
                );
              }}
            />
            <span className="truncate text-xs text-foreground-muted">
              {googleFile?.name ?? "No file chosen"}
            </span>
          </div>
        </>
      ) : (
        <input
          type="password"
          aria-label={shown.label}
          placeholder={shown.label}
          autoComplete="off"
          className={INPUT_CLASS}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
        />
      )}
      <p className="text-xs text-foreground-muted">
        It is encrypted here, in your browser, for your Switch Cloud alone: Switch only passes it
        on.
      </p>
      {error && <Alert>{error}</Alert>}
      <div>
        <Button onClick={start} disabled={!ready}>
          Start with {choice.label}
        </Button>
      </div>
    </>
  );
}

/**
 * Switch sets switch-buddy up while the person waits: the device comes up,
 * takes the login, and switch-buddy is made on it. A login the device turns
 * down goes back to the provider page with its reason.
 */
function SettingUpPage({
  exit,
  snapshot,
  refresh,
  readError,
  provider,
  login,
  person,
  onRefused,
  onCreated,
}: {
  exit: WizardExit;
  snapshot: CloudSnapshot | null;
  refresh: () => void;
  /** Why Switch Cloud could not be read or had just now, if it could not. */
  readError: string | null;
  provider: WebProvider;
  /** What was given; null to use the sign-in the device already has. */
  login: ProviderLogin | null;
  person: { name: string | null; email: string | null };
  onRefused: (reason: string) => void;
  onCreated: (agent: { agentId: string; name: string }) => Promise<void>;
}) {
  const name = providerName(provider);
  const controller = snapshot?.controller ?? null;
  const machine = snapshot?.machine ?? null;
  const up = deviceReady(snapshot);
  const providerReady = signedIn(controller, provider);
  const [operation, setOperation] = useState<string | null>(null);
  const [given, setGiven] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [long, setLong] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const woken = useRef(false);
  const giving = useRef(false);
  const created = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setLong(true), LONG_SETUP_MS);
    return () => clearTimeout(timer);
  }, []);

  // A device that is asleep, or that its owner stopped, is started again.
  useEffect(() => {
    if (!machine || woken.current || !needsWaking(machine)) return;
    woken.current = true;
    wakeCloudMachine(machine)
      .then(() => refresh())
      .catch((caught: unknown) => setError(message(caught, "Switch Cloud could not be started.")));
  }, [machine, refresh]);

  // Once it runs, it is given the login, sealed to its own key here.
  useEffect(() => {
    if (!up || !controller || providerReady || given || giving.current) return;
    if (login === null) {
      onRefused(`${name} is no longer signed in on Switch Cloud. Give it a login again.`);
      return;
    }
    giving.current = true;
    giveMachineLogin(controller, provider, login)
      .then((id) => {
        setOperation(id);
        setGiven(true);
      })
      .catch((caught: unknown) =>
        onRefused(message(caught, `${name} could not be given to Switch Cloud.`)),
      )
      .finally(() => {
        giving.current = false;
      });
  }, [up, controller, providerReady, given, login, provider, name, onRefused]);

  // How the device took the login up.
  useEffect(() => {
    if (operation === null || !controller) return;
    let stopped = false;
    const timer = setInterval(() => {
      void loginOutcome(controller.id, operation).then(
        (outcome) => {
          if (stopped || outcome.state === "pending") return;
          setOperation(null);
          if (outcome.state === "failed") onRefused(outcome.message);
          else refresh();
        },
        () => {},
      );
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [operation, controller, onRefused, refresh]);

  // A login it took but cannot sign in with.
  const problem = given && operation === null ? loginProblem(controller, provider) : null;
  useEffect(() => {
    if (problem) onRefused(problem);
  }, [problem, onRefused]);

  // Signed in: switch-buddy is made there, and its Welcome chat opens.
  useEffect(() => {
    if (!up || !providerReady || !controller || created.current) return;
    created.current = true;
    setCreating(true);
    setError(null);
    createBuddy({ controllerId: controller.id, provider, person })
      .then(onCreated)
      .catch((caught: unknown) => {
        created.current = false;
        setCreating(false);
        setError(message(caught, "switch-buddy could not be created."));
      });
    // `attempt` lets Try again run it once more.
  }, [up, providerReady, controller, provider, person, onCreated, attempt]);

  const stage = !up ? 0 : !providerReady ? 1 : 2;
  const stateOf = (index: number): SetupStageState =>
    index < stage ? "done" : index === stage ? "current" : "next";
  const deviceError =
    machine?.state === "error" ? (machine.error ?? "Switch Cloud did not start.") : null;

  return (
    <OnboardingSurface
      exit={exit}
      footer={
        deviceError ? (
          <Button
            onClick={() => {
              setError(null);
              cloudMachineLifecycle(machine!.machine_id, "retry", machine!.revision)
                .then(() => refresh())
                .catch((caught: unknown) =>
                  setError(message(caught, "Switch Cloud could not be started again.")),
                );
            }}
          >
            Try again
          </Button>
        ) : error && !creating ? (
          <Button onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
        ) : null
      }
    >
      <SetupChecklist
        title="Setting up switch-buddy…"
        stages={[
          { label: "Getting Switch Cloud ready", state: stateOf(0) },
          { label: `Connecting ${name}`, state: stateOf(1) },
          { label: "Creating switch-buddy", state: stateOf(2) },
        ]}
        note={
          deviceError || error
            ? null
            : long
              ? "Still working: the first setup can take a few minutes."
              : null
        }
      />
      {deviceError && <Alert>{deviceError}</Alert>}
      {error && <Alert>{error}</Alert>}
      {readError && !deviceError && !error && <Alert>{readError}</Alert>}
    </OnboardingSurface>
  );
}
