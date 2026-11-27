import "@switch-console/chat-ui/theme.css";
import { GiveMachineLogin } from "@switch-console/chat-ui/components/give-machine-login";
import {
  type MachineProviderRow,
  type MachineProvidersHost,
  MachineProvidersTable,
} from "@switch-console/chat-ui/components/machine-providers";
import type { BrowserSignInHost, MachineLoginInput } from "@switch-console/chat-ui/contracts/machine-logins";
import { browserSignInKind, providerLoginKinds } from "@switch-console/chat-ui/model/provider-catalogue";
import { failureText } from "@switch-console/chat-ui/model/failures";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import type { ProviderLogin } from "@switch-console/chat-ui/model/seal-login";
import type { Tone } from "@switch-console/chat-ui/primitives/tone-pill";
import { vertexLoginCredential } from "@switch-console/chat-ui/model/vertex-login";
import { QueryClient, useQuery } from "@tanstack/react-query";
import {
  type Controller,
  type ProviderStatus,
  browserSignIn,
  createOperation,
  fetchControllers,
  operationOutcome,
  sendSignInCode,
  startBrowserSignIn,
} from "../../data/management";
import { absoluteTitle, formatRelative } from "../../theme/format";
import { giveMachineLogin } from "../get-started/onboarding";
import { ProviderIcon } from "../get-started/ProviderIcon";

/** The queries of the AI providers views; the person's own devices are under `[...PROVIDERS_KEY, "devices"]`. */
export const PROVIDERS_KEY = ["ai-providers"] as const;

/** The AI providers views' own queries: the dashboard has no app-wide query client. */
export const providersQueryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

/** How often the person's devices are read again while a view of them is open. */
export const REFRESH_MS = 5_000;

/** The person's own devices, as they last reported, removed ones left out. */
export function useOwnDevices() {
  return useQuery({
    queryKey: [...PROVIDERS_KEY, "devices"],
    queryFn: async () => (await fetchControllers()).filter((device) => device.state !== "revoked"),
    refetchInterval: REFRESH_MS,
  });
}

/** A device's name as people know it: Switch names a cloud device for the product. */
export function deviceName(device: Controller): string {
  return device.kind === "ec2" ? "Switch Cloud" : device.name;
}

/** The login a device is given, from what was pasted or picked in the form. */
export function providerLogin(login: MachineLoginInput): ProviderLogin {
  if (login.source === "typed") return { kind: login.kind, credential: login.credential };
  if (login.source === "vertex" && login.credentials.from === "key")
    return {
      kind: "vertex",
      credential: vertexLoginCredential({
        project: login.project,
        region: login.region,
        googleCredentials: login.credentials.json,
      }),
    };
  throw new Error("A browser can't read this computer's sign-ins. Paste a key or token instead.");
}

function signIn(report: ProviderStatus): { tone: Tone; label: string; detail: string | null } {
  const detail = report.auth_problem ?? null;
  if (report.auth === "ok") return { tone: "ok", label: "Signed in", detail: null };
  if (report.auth === "missing") return { tone: "warning", label: "Not signed in", detail };
  if (report.auth === "expired") return { tone: "warning", label: "Sign-in expired", detail };
  if (detail) return { tone: "warning", label: "Sign-in could not be checked", detail };
  return { tone: "idle", label: "Checking sign-in…", detail: null };
}

/**
 * Each provider the device reported, as the table shows it. A login can be
 * given to a provider it has installed, signed in or not, so a person can
 * replace one; the device must be online and keep a key to seal it to.
 */
export function providerRows(device: Controller, label: (provider: string) => string): MachineProviderRow[] {
  const online = device.state === "online";
  return (device.status?.providers ?? []).map((report) => ({
    provider: report.provider,
    name: label(report.provider),
    icon: <ProviderIcon provider={report.provider} size={14} />,
    installed: report.installed,
    version: report.version,
    signIn: signIn(report),
    source:
      report.installed && report.auth === "ok" && report.auth_source
        ? report.auth_source === "sealed"
          ? "Given through Switch"
          : "On the device"
        : null,
    checked: report.checked_at
      ? { label: formatRelative(report.checked_at), title: absoluteTitle(report.checked_at) }
      : null,
    canGive: report.installed && online && Boolean(device.public_key) && loginOffered(report.provider),
    canRecheck: report.installed && online,
  }));
}

/** Whether this page can give `provider` a login: by what can be pasted or picked here. */
export function loginOffered(provider: string): boolean {
  return providerLoginKinds(provider, false).length > 0;
}

/** A provider as a device last reported it: ready, or why not, in a few words. */
export function providerReport(report: ProviderStatus) {
  const problem = !report.installed
    ? "not installed"
    : report.auth === "ok"
      ? null
      : report.auth === "missing"
        ? "not signed in"
        : report.auth === "expired"
          ? "sign-in expired"
          : report.auth_problem
            ? "sign-in could not be checked"
            : "sign-in not checked yet";
  return { provider: report.provider, ready: problem === null, problem };
}

/** Runs a browser sign-in for `provider` on the device: started there, followed and finished here. */
export function browserSignInHost(device: Controller, provider: string): BrowserSignInHost {
  const name = deviceName(device);
  return {
    start: () => startBrowserSignIn(device.id, provider),
    read: (operationId) =>
      browserSignIn(device.id, operationId, {
        expired: `${name} did not finish the sign-in in time. Start it again.`,
        cancelled: "A newer sign-in replaced this one.",
        failed: `${name} could not sign in.`,
      }),
    sendCode: sendSignInCode,
  };
}

/**
 * Gives the device a login for `provider`: signed in through a browser on
 * the device itself where it can be (first), or sealed in this browser for
 * the device alone; and says whether the provider signs in with it there.
 * Nothing for a provider this page cannot give a login.
 */
export function DeviceLoginForm({
  device,
  provider,
  providerName,
  onClose,
}: {
  device: Controller;
  provider: string;
  providerName: string;
  onClose: () => void;
}) {
  const browser = browserSignInKind(provider, device.kind === "ec2");
  const pasted = providerLoginKinds(provider, false);
  if (pasted.length === 0) return null;
  const name = deviceName(device);
  return (
    <GiveMachineLogin
      machineName={name}
      provider={provider}
      providerName={providerName}
      kinds={browser ? [browser, ...pasted] : pasted}
      thisComputer={false}
      browser={browser ? browserSignInHost(device, provider) : null}
      queryKey={PROVIDERS_KEY}
      give={(login) => giveMachineLogin(device, provider, providerLogin(login))}
      outcome={(operationId) =>
        operationOutcome(device.id, operationId, {
          expired: `${name} did not take the login up in time. Try again.`,
          failed: `${name} could not sign in with that login.`,
        })
      }
      failureText={failureText}
      onClose={onClose}
    />
  );
}

/**
 * A device's AI providers, as Switch Console shows a machine's: whether each
 * is installed and signed in, with Give login (sealed in this browser for the
 * device alone) and Recheck. Needs `providersQueryClient` above it.
 */
export function DeviceProviders({ device, label }: { device: Controller; label: (provider: string) => string }) {
  const name = deviceName(device);
  const host: MachineProvidersHost = {
    queryKey: PROVIDERS_KEY,
    recheck: async (provider) =>
      (
        await createOperation({
          controller_id: device.id,
          agent_id: null,
          kind: "provider.recheck",
          params: { provider },
        })
      ).id,
    recheckOutcome: (operationId) =>
      operationOutcome(device.id, operationId, {
        expired: `${name} did not check the provider in time. Is it online?`,
        failed: `${name} could not check the provider.`,
      }),
    giveLogin: (provider, onClose) => (
      <DeviceLoginForm device={device} provider={provider} providerName={label(provider)} onClose={onClose} />
    ),
    failureText,
  };
  const missing = (device.status?.providers ?? []).some((report) => !report.installed);
  return (
    <div className={SHARED_UI_CLASS}>
      <MachineProvidersTable machineName={name} rows={providerRows(device, label)} host={host} />
      {missing && (
        <p className="mt-2 text-[12px] text-[var(--fg-dim)]">
          Switch can't install a provider on {name}: install its CLI there, then recheck it here.
        </p>
      )}
    </div>
  );
}
