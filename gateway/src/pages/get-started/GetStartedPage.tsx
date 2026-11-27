import "@switch-console/chat-ui/theme.css";
import { BrowserSignInPanel } from "@switch-console/chat-ui/components/browser-sign-in";
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
import type { BrowserSignInState } from "@switch-console/chat-ui/contracts/machine-logins";
import { failureText } from "@switch-console/chat-ui/model/failures";
import {
  type LoginKindOption,
  browserSignInKind,
  loginHint,
  machineProviderOptions,
  providerLoginKinds,
  providerReportSettled,
} from "@switch-console/chat-ui/model/provider-catalogue";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import { type ProviderLogin, signInFileCredential } from "@switch-console/chat-ui/model/seal-login";
import {
  VERTEX_DEFAULT_REGION,
  vertexLoginCredential,
} from "@switch-console/chat-ui/model/vertex-login";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { SegmentedControl } from "@switch-console/chat-ui/primitives/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@switch-console/chat-ui/primitives/select";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { QueryClientProvider } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { fetchAuthConfig } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import {
  type Controller,
  type ProviderInfo,
  cloudMachineLifecycle,
  fetchProviders,
  sendSignInCode,
} from "../../data/management";
import { browserSignInHost, providerReport, providersQueryClient } from "../ai-providers/DeviceProviders";
import AddMachineDialog from "../machines/AddMachineDialog";
import {
  CLOUD_DEVICE_PROVIDERS,
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
import { ConsoleHint } from "./ConsoleHint";
import { ProviderIcon } from "./ProviderIcon";
import { type CloudSnapshot, deviceReady, useCloudDevice } from "./useCloudDevice";
import { useLocalDevice, localDeviceReady } from "./useLocalDevice";

/** Where Skip goes, so an AI provider can be connected later. */
const AI_PROVIDERS = "/settings/ai-providers";

/** How long setting up runs before the page says a long one is expected. */
const LONG_SETUP_MS = 30_000;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The provider's name as Switch lists it. */
function providerName(providers: ProviderInfo[] | null, provider: string): string {
  return providers?.find((each) => each.id === provider)?.label ?? provider;
}

/** A provider the device reports signed in. */
function signedIn(controller: Controller | null, provider: string): boolean {
  return (controller?.status?.providers ?? []).some(
    (each) => each.provider === provider && each.installed && each.auth === "ok",
  );
}

/** Why the device says the provider's login does not work, or null while it has not said. */
function loginProblem(controller: Controller | null, provider: string, name: string): string | null {
  const status = (controller?.status?.providers ?? []).find((each) => each.provider === provider);
  if (!status || status.auth_source !== "sealed" || status.auth === "ok") return null;
  if (status.auth !== "expired") return null;
  return status.auth_problem ?? `${name} did not sign in with that login.`;
}

type Page =
  | { kind: "meet" }
  | { kind: "provider"; error: string | null }
  | { kind: "setting-up"; provider: string; login: GivenLogin };

/** What switch-buddy's provider is given: a login pasted or picked, a browser sign-in on the device, or nothing (it has one). */
type GivenLogin = ProviderLogin | "browser" | null;

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
  const { user, session, refresh: refreshSession } = useAuth();
  const tenantId = session?.tenant?.id ?? null;
  const navigate = useNavigate();
  const cloud = useCloudDevice();
  const local = useLocalDevice();
  const [page, setPage] = useState<Page>({ kind: "meet" });
  const firstName = user?.name?.split(/\s+/)[0] || null;
  const exit: WizardExit = { label: "Finish later", onExit: () => navigate("/") };
  const cloudBuddy = buddyOf(cloud.snapshot?.agents);
  const unavailable = cloud.snapshot?.available === false;
  const useLocal = unavailable;
  const snapshot = useLocal ? null : cloud.snapshot;
  const error = useLocal ? local.error : cloud.error;
  const refresh = useLocal ? local.refresh : cloud.refresh;
  const buddy = cloudBuddy;
  const [testServer, setTestServer] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  useEffect(() => {
    fetchProviders().then(setProviders, (caught: unknown) =>
      setProvidersError(message(caught, "The AI providers Switch runs could not be read.")),
    );
  }, []);
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
          localDevice={useLocal ? local : null}
          readError={error ?? providersError}
          providers={providers}
          existing={buddy ? { agentId: buddy.agent_id, name: buddy.name } : null}
          onOpen={openChat}
          onStart={(provider) => setPage({ kind: "setting-up", provider, login: null })}
          onSetUp={() => setPage({ kind: "provider", error: null })}
          onSkip={() => navigate(AI_PROVIDERS)}
          testServer={testServer}
          onStartOver={async () => {
            if (!user) return;
            await startOver({
              buddyId: buddy?.agent_id ?? null,
              controller: snapshot?.controller ?? null,
              email: user.email,
            });
            // Signed out by the server: signing in again starts from the beginning.
            if (tenantId) forgetGetStartedVisit(user.id, tenantId);
            await refreshSession();
          }}
        />
      ) : page.kind === "provider" ? (
        <ProviderPage
          exit={exit}
          snapshot={snapshot}
          localDevice={useLocal ? local : null}
          providers={providers}
          error={page.error ?? providersError}
          onBack={() => setPage({ kind: "meet" })}
          onSkip={() => navigate(AI_PROVIDERS)}
          onStart={(provider, login) => setPage({ kind: "setting-up", provider, login })}
        />
      ) : (
        <SettingUpPage
          exit={exit}
          snapshot={snapshot}
          localDevice={useLocal ? local : null}
          refresh={refresh}
          readError={error}
          provider={page.provider}
          name={providerName(providers, page.provider)}
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
  localDevice,
  readError,
  providers,
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
  localDevice: ReturnType<typeof useLocalDevice> | null;
  readError: string | null;
  /** The providers Switch runs; null while they load. */
  providers: ProviderInfo[] | null;
  existing: { agentId: string; name: string } | null;
  onOpen: (agent: { agentId: string; name: string }) => Promise<void>;
  onStart: (provider: string) => void;
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
  const [addingDevice, setAddingDevice] = useState(false);
  const unavailable = snapshot?.available === false;
  const useLocal = localDevice !== null;

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
  ) : unavailable && !useLocal ? (
    <Button variant="outline" onClick={onSkip}>
      Continue
    </Button>
  ) : null;
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
    testServer ? (
      <>
        {main}
        <Button variant="ghost" onClick={() => setConfirming(true)} disabled={resetting}>
          Start over
        </Button>
      </>
    ) : (
      main
    );
  const activeController = useLocal ? localDevice.snapshot?.selected ?? null : snapshot?.controller ?? null;
  const signedInHere = (providers ?? [])
    .filter((each) => signedIn(activeController, each.id))
    .map((each) => ({ id: each.id, name: each.label }));
  const deviceName = useLocal && activeController ? activeController.name : "Switch Cloud";

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
          existing || (unavailable && !useLocal) ? null : (
            <>
              {useLocal && (!localDevice.snapshot || localDevice.snapshot.controllers.length === 0) && (
                <div className="mx-auto max-w-[540px] rounded-xl border border-border bg-background p-4 text-center">
                  <p className="mb-3 text-sm text-foreground">
                    switch-buddy needs a device to run on. Add one to continue.
                  </p>
                  <Button onClick={() => setAddingDevice(true)}>Add a device</Button>
                </div>
              )}
              {useLocal && localDevice.snapshot && localDevice.snapshot.controllers.length > 0 && (
                <>
                  {localDevice.snapshot.controllers.length > 1 && (
                    <div className="mx-auto max-w-[540px] text-center">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-sm text-foreground-muted">Device:</span>
                        <Select
                          value={localDevice.snapshot.selected?.id ?? ""}
                          onValueChange={(value) => localDevice.select(value)}
                        >
                          <SelectTrigger aria-label="Device">
                            <SelectValue>{localDevice.snapshot.selected?.name}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {localDevice.snapshot.controllers.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                  <BuddyStartCard
                    checking={false}
                    ready={signedInHere}
                    starting={null}
                    onStart={onStart}
                    onSetUp={onSetUp}
                    onSkip={onSkip}
                    icon={(id, size) => <ProviderIcon provider={id} size={size} />}
                    readyTag={`Signed in on ${deviceName}`}
                    info={null}
                  />
                </>
              )}
              {!useLocal && (
                <>
                  <BuddyStartCard
                    checking={snapshot === null || providers === null}
                    ready={signedInHere}
                    starting={null}
                    onStart={onStart}
                    onSetUp={onSetUp}
                    onSkip={onSkip}
                    icon={(id, size) => <ProviderIcon provider={id} size={size} />}
                    readyTag="Signed in on Switch Cloud"
                    info={null}
                  />
                  <ConsoleHint lead="switch-buddy runs on your Switch Cloud." />
                </>
              )}
            </>
          )
        }
      />
      {unavailable && !existing && !useLocal && (
        <p className="text-center text-sm text-foreground-muted">
          Switch has no cloud devices for this workspace, so switch-buddy needs a device of your
          own. Add one under Devices.
        </p>
      )}
      {confirming && (
        <div className="mx-auto flex max-w-[540px] flex-col items-center gap-3 rounded-xl border border-border bg-background p-4 text-center">
          <p className="text-sm text-foreground">
            Start getting started over? The workspaces only you are in are deleted, with
            switch-buddy, your agents and your Switch Cloud, and you are signed out. You keep your
            sign-in, so signing in again starts from the beginning. For testing only.
          </p>
          {resetting && (
            <p className="text-xs text-foreground-muted">
              Removing your Switch Cloud can take a few minutes.
            </p>
          )}
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
      {addingDevice && (
        <AddMachineDialog
          open={addingDevice}
          onClose={() => {
            setAddingDevice(false);
            localDevice?.refresh();
          }}
        />
      )}
    </OnboardingSurface>
  );
}

/** A provider's card on the provider page: what it says, and whether it can be picked and given a login. */
type ProviderCard = {
  id: string;
  name: string;
  tag: string;
  tone: "ready" | "checking" | "plain";
  disabled: boolean;
  logins: LoginKindOption[];
};

/**
 * Every provider Switch runs, as a card saying where it stands on the device:
 * signed in, ready for a login given here, or why it cannot be picked. Until
 * a cloud device has checked a provider, it can be picked if every cloud
 * device installs it, and waits for the check otherwise; one the device left
 * out of a settled report is not available there.
 */
function providerCards(
  providers: ProviderInfo[],
  controller: Controller | null,
  deviceName: string,
  cloud: boolean,
): ProviderCard[] {
  const reports = (controller?.status?.providers ?? []).map(providerReport);
  const options = machineProviderOptions(
    providers.map((each) => ({ id: each.id, name: each.label })),
    reports,
    providerReportSettled(
      controller?.connection?.connected_at ?? null,
      controller?.status?.observed_at ?? null,
    ),
  );
  return options.map(({ id, name, ready, problem }) => {
    const browser = browserSignInKind(id, cloud);
    const pasted = providerLoginKinds(id, false);
    const logins = browser ? [browser, ...pasted] : pasted;
    const card = { id, name, logins };
    if (ready) return { ...card, tag: `Signed in on ${deviceName}`, tone: "ready", disabled: false };
    if (problem === "not installed")
      return { ...card, tag: `Not installed on ${deviceName}`, tone: "plain", disabled: true };
    if (problem === "not available")
      return { ...card, tag: `Not available on ${deviceName}`, tone: "plain", disabled: true };
    if (problem === "not checked yet" && !(cloud && CLOUD_DEVICE_PROVIDERS.includes(id)))
      return { ...card, tag: `Checking ${deviceName}…`, tone: "checking", disabled: true };
    if (logins.length === 0)
      return {
        ...card,
        tag: `Sign in to it on ${deviceName} itself`,
        tone: "plain",
        disabled: true,
      };
    return { ...card, tag: "Not signed in", tone: "plain", disabled: false };
  });
}

/** Pick the AI provider switch-buddy runs on, and give its login. */
function ProviderPage({
  exit,
  snapshot,
  localDevice,
  providers,
  error,
  onBack,
  onSkip,
  onStart,
}: {
  exit: WizardExit;
  snapshot: CloudSnapshot | null;
  localDevice: ReturnType<typeof useLocalDevice> | null;
  /** The providers Switch runs; null while they load. */
  providers: ProviderInfo[] | null;
  /** Why the last login did not work, from setting up. */
  error: string | null;
  onBack: () => void;
  onSkip: () => void;
  onStart: (provider: string, login: GivenLogin) => void;
}) {
  const controller = localDevice?.snapshot?.selected ?? snapshot?.controller ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const deviceName = localDevice?.snapshot?.selected?.name ?? "Switch Cloud";
  const cards = providerCards(providers ?? [], controller, deviceName, localDevice === null);
  const selected = cards.find((card) => card.id === selectedId && !card.disabled) ?? null;
  // Picking one that needs a login leaves it alone above its login, so the login is in view.
  const signingIn = selected !== null && !signedIn(controller, selected.id);
  const shown = signingIn ? [selected] : cards;
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
        <p className="text-sm text-foreground">
          {localDevice === null
            ? "Your Switch Cloud starts with no AI logins. Pick an AI provider to power switch-buddy and sign in to it:"
            : "Pick an AI provider to power switch-buddy:"}
        </p>
        <ul className="grid gap-3 sm:grid-cols-3">
          {shown.map((card) => (
            <ProviderChoiceCard
              key={card.id}
              icon={<ProviderIcon provider={card.id} size={28} />}
              name={card.name}
              tag={card.tag}
              tone={card.tone}
              selected={selected?.id === card.id}
              disabled={card.disabled}
              onSelect={() => setSelectedId(card.id)}
              signIn={
                card.disabled || card.tone === "ready" || signingIn
                  ? null
                  : () => setSelectedId(card.id)
              }
            />
          ))}
        </ul>
        {signingIn && (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setSelectedId(null)}>
            Choose another provider
          </Button>
        )}
        {providers === null && !error && (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Spinner className="size-3" />
            Listing the AI providers Switch runs…
          </p>
        )}
        {selected && (
          <ProviderActionPanel providerId={selected.id}>
            {signedIn(controller, selected.id) ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    Use the {selected.name} sign-in it already has
                  </p>
                  <p className="text-xs text-foreground-muted">
                    switch-buddy runs on {deviceName} with the {selected.name} login given to it
                    before.
                  </p>
                </div>
                <div>
                  <Button onClick={() => onStart(selected.id, null)}>
                    Start with {selected.name}
                  </Button>
                </div>
              </>
            ) : (
              <LoginForm
                key={selected.id}
                provider={selected.id}
                name={selected.name}
                kinds={selected.logins}
                onStart={(login) => onStart(selected.id, login)}
              />
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

/** A key or token pasted here, as a login; a kind that is not pasted is refused. */
function typedLogin(kind: "setup-token" | "api-key" | null, credential: string): ProviderLogin {
  if (kind === null) throw new Error("That login cannot be pasted here.");
  return { kind, credential: credential.trim() };
}

/** The login to give the provider: what is pasted or picked here, checked before anything is sent. */
function LoginForm({
  provider,
  name,
  kinds,
  onStart,
}: {
  provider: string;
  name: string;
  /** The logins it can be given here, the first picked at first. */
  kinds: LoginKindOption[];
  onStart: (login: ProviderLogin | "browser") => void;
}) {
  const [kind, setKind] = useState(kinds[0]!.value);
  const shown = kinds.find((each) => each.value === kind) ?? kinds[0]!;
  const [credential, setCredential] = useState("");
  const [project, setProject] = useState("");
  const [region, setRegion] = useState(VERTEX_DEFAULT_REGION);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const browser = shown.value === "browser";
  const vertex = shown.value === "vertex";
  const signInFile = shown.value === "auth-json";
  const typed = shown.value === "setup-token" || shown.value === "api-key" ? shown.value : null;
  const ready = browser
    ? true
    : vertex
    ? file !== null && project.trim() !== "" && region.trim() !== ""
    : signInFile
      ? file !== null
      : credential.trim() !== "";

  const start = () => {
    setError(null);
    if (browser) {
      onStart("browser");
      return;
    }
    try {
      onStart(
        vertex
          ? {
              kind: "vertex",
              credential: vertexLoginCredential({
                project,
                region,
                googleCredentials: file?.text ?? "",
              }),
            }
          : signInFile
            ? { kind: "auth-json", credential: signInFileCredential(file?.text ?? "") }
            : typedLogin(typed, credential),
      );
    } catch (caught) {
      setError(message(caught, "That login cannot be used."));
    }
  };

  const filePicker = (
    <div className="flex items-center gap-2">
      <Button variant="outline" autoFocus={signInFile} onClick={() => picker.current?.click()}>
        Choose JSON file
      </Button>
      <input
        ref={picker}
        hidden
        type="file"
        accept="application/json,.json"
        aria-label={vertex ? "Google credential file" : `${name} sign-in file`}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (!picked) return;
          void picked.text().then(
            (text) => setFile({ name: picked.name, text }),
            () => setError(`${picked.name} could not be read.`),
          );
        }}
      />
      <span className="truncate text-xs text-foreground-muted">{file?.name ?? "No file chosen"}</span>
    </div>
  );

  return (
    <>
      {kinds.length > 1 && (
        <SegmentedControl
          value={shown.value}
          onChange={setKind}
          ariaLabel="How it signs in"
          className="self-start"
          options={kinds}
        />
      )}
      <p className="text-xs text-foreground-muted">
        <WithCode
          text={
            vertex
              ? `${name} signs in to Google Vertex AI. Pick the JSON key of a service account that can use only Vertex AI (roles/aiplatform.user), or the sign-in \`gcloud auth application-default login\` writes.`
              : loginHint(provider, name, shown.value, "key")
          }
        />
      </p>
      {browser ? null : vertex ? (
        <>
          <div className="flex gap-2">
            <label className="flex-1 space-y-1 text-xs text-foreground-muted">
              <span>Google Cloud project</span>
              <input
                aria-label="Google Cloud project"
                autoFocus
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
          {filePicker}
        </>
      ) : signInFile ? (
        filePicker
      ) : (
        <input
          type="password"
          aria-label={shown.label}
          autoFocus
          placeholder={shown.label}
          autoComplete="off"
          className={INPUT_CLASS}
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
        />
      )}
      <p className="text-xs text-foreground-muted">
        {browser
          ? "Your device runs the sign-in once it is up; this page shows you where to sign in."
          : "It is encrypted here, in your browser, for your device alone: Switch only passes it on."}
      </p>
      {error && <Alert>{error}</Alert>}
      <div>
        <Button onClick={start} disabled={!ready}>
          Start with {name}
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
  localDevice,
  refresh,
  readError,
  provider,
  name,
  login,
  person,
  onRefused,
  onCreated,
}: {
  exit: WizardExit;
  snapshot: CloudSnapshot | null;
  localDevice: ReturnType<typeof useLocalDevice> | null;
  refresh: () => void;
  /** Why the device could not be read just now, if it could not. */
  readError: string | null;
  provider: string;
  /** The provider's name as Switch lists it. */
  name: string;
  /** What was given; null to use the sign-in the device already has. */
  login: GivenLogin;
  person: { name: string | null; email: string | null };
  onRefused: (reason: string) => void;
  onCreated: (agent: { agentId: string; name: string }) => Promise<void>;
}) {
  const useLocal = localDevice !== null;
  const controller = localDevice?.snapshot?.selected ?? snapshot?.controller ?? null;
  const machine = snapshot?.machine ?? null;
  const up = useLocal ? localDeviceReady(controller) : deviceReady(snapshot);
  const providerReady = signedIn(controller, provider);
  const deviceName = controller?.name ?? "Switch Cloud";
  const [operation, setOperation] = useState<string | null>(null);
  const [signInId, setSignInId] = useState<string | null>(null);
  const [signInState, setSignInState] = useState<BrowserSignInState>({ state: "starting" });
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

  // A cloud device that is asleep, or that its owner stopped, is started again.
  // A start the server refuses shows its reason; Try again asks again.
  useEffect(() => {
    if (useLocal || !machine || woken.current || !needsWaking(machine)) return;
    woken.current = true;
    wakeCloudMachine(machine)
      .then(() => refresh())
      .catch((caught: unknown) => setError(message(caught, `${deviceName} could not be started.`)));
  }, [useLocal, machine, refresh, deviceName, attempt]);

  // Once it runs, it is given the login, sealed to its own key here.
  useEffect(() => {
    if (!up || !controller || providerReady || given || giving.current) return;
    if (login === null) {
      onRefused(`${name} is no longer signed in on ${deviceName}. Give it a login again.`);
      return;
    }
    giving.current = true;
    if (login === "browser") {
      browserSignInHost(controller, provider)
        .start()
        .then((id) => {
          setSignInId(id);
          setGiven(true);
        })
        .catch((caught: unknown) =>
          onRefused(message(caught, `${name} could not be signed in on ${deviceName}.`)),
        )
        .finally(() => {
          giving.current = false;
        });
      return;
    }
    giveMachineLogin(controller, provider, login)
      .then((id) => {
        setOperation(id);
        setGiven(true);
      })
      .catch((caught: unknown) =>
        onRefused(message(caught, `${name} could not be given to ${deviceName}.`)),
      )
      .finally(() => {
        giving.current = false;
      });
  }, [up, controller, providerReady, given, login, provider, name, deviceName, onRefused]);

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

  // Where the browser sign-in on the device stands, until it ends.
  useEffect(() => {
    if (signInId === null || !controller) return;
    const host = browserSignInHost(controller, provider);
    let stopped = false;
    const timer = setInterval(() => {
      void host.read(signInId).then(
        (state) => {
          if (stopped) return;
          setSignInState(state);
          if (state.state === "failed") {
            setSignInId(null);
            onRefused(state.message);
          } else if (state.state === "succeeded") {
            setSignInId(null);
            refresh();
          }
        },
        () => {},
      );
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signInId, controller, provider, onRefused, refresh]);

  // A login it took but cannot sign in with.
  const problem = given && operation === null ? loginProblem(controller, provider, name) : null;
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
  const stoppedByAdmin = !useLocal && machine?.stopped_by_admin === true;
  const deviceError = stoppedByAdmin
    ? `A Switch administrator stopped ${deviceName}. Contact them to have it released.`
    : !useLocal && machine?.state === "error"
      ? (machine.error ?? `${deviceName} did not start.`)
      : null;
  const stageLabel = useLocal ? "Getting your device ready" : `Getting ${deviceName} ready`;

  return (
    <OnboardingSurface
      exit={exit}
      footer={
        deviceError && !stoppedByAdmin ? (
          <Button
            onClick={() => {
              setError(null);
              cloudMachineLifecycle(machine!.machine_id, "retry", machine!.revision)
                .then(() => refresh())
                .catch((caught: unknown) =>
                  setError(message(caught, `${deviceName} could not be started again.`)),
                );
            }}
          >
            Try again
          </Button>
        ) : error && !creating ? (
          <Button
            onClick={() => {
              woken.current = false;
              setError(null);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </Button>
        ) : null
      }
    >
      <SetupChecklist
        title="Setting up switch-buddy…"
        stages={[
          { label: stageLabel, state: stateOf(0) },
          { label: `Connecting ${name}`, state: stateOf(1) },
          { label: "Creating switch-buddy", state: stateOf(2) },
        ]}
        note={
          deviceError || error || readError
            ? null
            : long
              ? "Still working: the first setup can take a few minutes."
              : null
        }
      />
      {signInId !== null && (
        <QueryClientProvider client={providersQueryClient}>
          <BrowserSignInPanel
            machineName={deviceName}
            provider={provider}
            providerName={name}
            state={signInState}
            sendCode={(code) => sendSignInCode(signInId, code)}
            failureText={failureText}
          />
        </QueryClientProvider>
      )}
      {deviceError && <Alert>{deviceError}</Alert>}
      {error && <Alert>{error}</Alert>}
      {readError && !deviceError && !error && <Alert>{readError}</Alert>}
    </OnboardingSurface>
  );
}
